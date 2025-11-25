/**
 * iPhone Safari
 * iPad Safari (desktop UA 모드 포함)
 */
export default function isIosSafari() {
  const ua = navigator.userAgent;

  // iOS 또는 iPadOS 판별
  const isIOS = /iP(ad|hone|od)/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Safari 판별 (다른 iOS 브라우저 제외)
  const isSafari =
    ua.includes('Safari') &&
    !ua.includes('CriOS') &&
    !ua.includes('FxiOS') &&
    !ua.includes('OPiOS') &&
    !ua.includes('EdgiOS');

  return isIOS && isSafari;
}
