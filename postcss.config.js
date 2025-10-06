import postcssDiscardComments from 'postcss-discard-comments';

export default {
  plugins: [
    [
      'postcss-preset-env',
      postcssDiscardComments({
        removeAll: true,
      }),
      {
        browsers: '> 5% in KR, defaults, not IE < 11',
        // CSS Grid 활성화 [false, 'autoplace', 'no-autoplace']
        autoprefixer: { grid: 'autoplace' },
      },
    ],
  ],
};
