import dotenv from 'dotenv';
dotenv.config();

const DefaultEnv = {
  'process.env.SOCKET_HOST': JSON.stringify(process.env.SOCKET_HOST),
  'process.env.SOCKET_PORT': JSON.stringify(process.env.SOCKET_PORT),
  'process.env.RTC_PORT': JSON.stringify(process.env.RTC_PORT),
  'process.env.CLIENT_HOST': JSON.stringify(process.env.CLIENT_HOST),
  'process.env.CLIENT_PORT': JSON.stringify(process.env.CLIENT_PORT),
};

export default {
  ...DefaultEnv,
};
