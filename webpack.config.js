import dotenv from 'dotenv';
dotenv.config();
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { CleanWebpackPlugin } from 'clean-webpack-plugin';
import webpack from 'webpack';
import CssMinimizerPlugin from 'css-minimizer-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import webpackDevServer from 'webpack-dev-server';
import { PurgeCSSPlugin } from 'purgecss-webpack-plugin';
import { globSync } from 'glob';
import WebpackObfuscator from 'webpack-obfuscator';
import multipleHtmlPlugins from './src/client/js/webpack/htmlPage.js';
import multipleJsPlugins from './src/client/js/webpack/jsPage.js';
// import commonEnv from './src/client/js/webpack/env/commonEnv.js';
// import fs from 'fs';
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);
// const glob = require('glob');

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODE = process.env.MODE === 'development';

const PATHS = {
  src: path.join(__dirname, 'src'),
};

const webpackConfig = {
  mode: process.env.MODE, // development | production
  resolve: {
    // webpack과 관련해 import 하는 파일은 @ 경로 사용 불가
    alias: {
      '@': path.resolve(__dirname, 'src'), // @를 src 디렉토리로 설정
    },
    extensions: ['.js', '.scss'], // 확장자 생략 가능
  },
  devtool: MODE ? 'source-map' : false,
  entry: multipleJsPlugins,
  output: {
    // filename: "js/[name].bundle.js",
    filename: '[name].[chunkhash].js',
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.m?js$/i,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env'],
          },
        },
      },
      {
        test: /\.s[ac]ss$/i,
        use: [
          MiniCssExtractPlugin.loader,
          {
            // 매우중요*** hash된 이미지 경로와 이미지명을 함께 번들링해줌
            loader: 'css-loader',
            options: {
              sourceMap: true,
              url: true,
              esModule: false,
              importLoaders: 2,
            },
          },
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                config: 'postcss.config.js', // postcss.config.js 파일을 사용
              },
            },
          },
          {
            loader: 'sass-loader',
            options: {
              sourceMap: true,
            },
          },
        ],
      },
      {
        test: /\.(png|jpe?g|gif|svg|webp)$/i,
        exclude: /node_modules/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: '[path][name].[ext]',
              context: 'src/',
            },
          },
          {
            loader: 'image-webpack-loader',
            options: {
              mozjpeg: {
                progressive: true,
              },
              optipng: {
                enabled: false,
              },
              pngquant: {
                quality: [0.65, 0.9],
                speed: 4,
              },
              gifsicle: {
                interlaced: false,
              },
              webp: {
                quality: 75,
              },
            },
          },
        ],
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        // type: "asset/resource",
        use: [
          {
            loader: 'file-loader',
            options: {
              name: '[path][name].[ext]',
              context: 'src/',
            },
          },
        ],
      },
    ],
  },
  plugins: [
    new CleanWebpackPlugin(),
    new MiniCssExtractPlugin({
      linkType: 'text/css',
      filename: 'css/[name]/[name].css',
      // ignoreOrder: true, // CSS 순서 충돌 경고 무시
    }),
    new webpack.DefinePlugin({
      'process.env.SOCKET_HOST': JSON.stringify(process.env.SOCKET_HOST),
      'process.env.SOCKET_PORT': JSON.stringify(process.env.SOCKET_PORT),
      'process.env.RTC_PORT': JSON.stringify(process.env.RTC_PORT),
      'process.env.CLIENT_HOST': JSON.stringify(process.env.CLIENT_HOST),
      'process.env.CLIENT_PORT': JSON.stringify(process.env.CLIENT_PORT),
    }),
    ...(MODE
      ? []
      : [
          new PurgeCSSPlugin({
            paths: globSync(`${PATHS.src}/**/*`, { nodir: true }),
          }),
          // production 모드일 경우 build 코드 난독화
          new WebpackObfuscator(
            {
              rotateStringArray: true,
              stringArray: true,
              stringArrayEncoding: ['base64'], // 또는 'rc4'
              stringArrayThreshold: 0.75, // 75%의 문자열을 난독화
            },
            ['vendors.*.js'], // 예외 처리할 파일
          ),
        ]),
  ].concat(multipleHtmlPlugins),
  optimization: {
    runtimeChunk: 'single',
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          format: {
            comments: false,
          },
        },
      }),
      new CssMinimizerPlugin(),
    ],
    splitChunks: {
      chunks: 'all',
      minSize: 20000,
      maxSize: 150000, // 150KB 이상이면 나눔
      enforceSizeThreshold: 100000, // 100KB 넘으면 강제 분할
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name(module) {
            const pkg = module.context.match(/[\\/]node_modules[\\/](.*?)([\\/]|$)/);
            return `vendor.${pkg?.[1]?.replace('@', '') ?? 'misc'}`;
          },
          chunks: 'all',
        },
        common: {
          name: 'common',
          minChunks: 2,
          priority: -10,
          reuseExistingChunk: true,
        },
      },
    },
  },
  performance: {
    hints: false, // 'warning' 개발/운영 모두에서 경고 끔 (크기 문제만 표시하므로)
    maxEntrypointSize: 500000,
    maxAssetSize: 500000,
  },
};

const compiler = webpack(webpackConfig);
const server = new webpackDevServer(
  {
    static: {
      directory: path.resolve(__dirname, 'src'), // 정적 파일 제공 디렉터리
    },
    /* server: {
      type: 'https',
      options: {
        key: fs.readFileSync(path.resolve(__dirname, 'certs/client/localhost-key.pem')),
        cert: fs.readFileSync(path.resolve(__dirname, 'certs/client/localhost.pem')),
      },
    }, */
    compress: true,
    port: process.env.CLIENT_PORT,
    hot: true,
    client: {
      progress: true,
    },
    // server: {
    //   type: "https", // HTTPS 설정
    //   options: {
    //     // 기본 인증서를 사용할 경우 주석 처리된 부분을 삭제하세요.
    //     key: fs.readFileSync("certs/client/cert.key"), // 자체 서명된 인증서 키
    //     cert: fs.readFileSync("certs/client/cert.crt"), // 자체 서명된 인증서
    //   },
    // },
    historyApiFallback: {
      rewrites: [
        { from: /^\/game$/, to: '/game.html' },
      ],
    },
    proxy: [
      {
        context: ['/api'], // 1) 프록시를 적용할 경로
        target: `${process.env.JWT_HOST}:${process.env.JWT_PORT}`, // 2) 프록시 대상 서버 주소 (백엔드 API 서버)
        changeOrigin: true, // 3) Origin 헤더를 target 주소로 변경
        pathRewrite: { '^/api': '' }, // 4) /api 접두어를 제거하고 요청
      },
    ],
  },
  compiler,
);

(async () => {
  await server.start();
  console.log('dev server is running');
})();

export default webpackConfig;
