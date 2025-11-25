/**
 * iPhone / iPod / iPad (전통적 UA 방식)
 */
export default function isAppleDevice() {
  const ua = navigator.userAgent;
  const platform = navigator.platform;

  // iPhone, iPad, iPod 체크
  const isIOS = /iP(hone|ad|od)/.test(ua);

  // iPadOS 13+ (iPad가 desktop Safari처럼 보임)
  const isIPadOS = platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  // macOS 체크
  const isMac = platform === 'MacIntel' && navigator.maxTouchPoints === 1;

  return isIOS || isIPadOS || isMac;
}
