import dotenv from 'dotenv';
dotenv.config({ path: '.env.blackAndWhite1' });

const BLACK_AND_WHITE_1 = {
  'process.env.VAL_BLACK_AND_WHITE_1_GAME_NAME': JSON.stringify(process.env.VAL_BLACK_AND_WHITE_1_GAME_NAME),
};

export default {
  ...BLACK_AND_WHITE_1,
};
