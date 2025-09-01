import dotenv from 'dotenv';
dotenv.config({ path: '.env.findTheSamePicture' });

const FIND_THE_SAME_PICTURE = {
  'process.env.VAL_FIND_THE_SAME_PICTURE_GAME_NAME': JSON.stringify(process.env.VAL_FIND_THE_SAME_PICTURE_GAME_NAME),
};

export default {
  ...FIND_THE_SAME_PICTURE,
};
