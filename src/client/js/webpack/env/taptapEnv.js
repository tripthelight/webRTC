import dotenv from 'dotenv';
dotenv.config({ path: '.env.taptap' });

const TAPTAP = {
  'process.env.VAL_TAPTAP_GAME_NAME': JSON.stringify(process.env.VAL_TAPTAP_GAME_NAME),
};

export default {
  ...TAPTAP,
};
