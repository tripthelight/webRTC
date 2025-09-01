import dotenv from 'dotenv';
dotenv.config({ path: '.env.indianPocker' });

const INDIAN_POCKER = {
  'process.env.KEY_INDIAN_POCKER_CARD_NUM': JSON.stringify(process.env.KEY_INDIAN_POCKER_CARD_NUM),
  'process.env.VAL_INDIAN_POCKER_GAME_NAME': JSON.stringify(process.env.VAL_INDIAN_POCKER_GAME_NAME),
};

export default {
  ...INDIAN_POCKER,
};
