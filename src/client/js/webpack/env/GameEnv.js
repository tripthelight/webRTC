import dotenv from 'dotenv';
dotenv.config({ path: '.env.game' });

const COMN_STORAGE = {
  'process.env.KEY_GAME_NAME': JSON.stringify(process.env.KEY_GAME_NAME),
  'process.env.KEY_ROOM_NAME': JSON.stringify(process.env.KEY_ROOM_NAME),
};

export default {
  ...COMN_STORAGE,
};
