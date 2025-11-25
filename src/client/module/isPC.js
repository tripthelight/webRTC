/**
 * PC / no PC 구분 코드
 */
export function isPC() {
  // 1) 포인터 타입이 정확히 'fine'이면 PC 가능성이 매우 높음
  const isFinePointer = window.matchMedia('(pointer: fine)').matches;

  // 2) 모바일 디바이스 체크 (iPhone, Android, iPad 등)
  const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // PC = 포인터 fine AND 모바일 UA 아님
  return isFinePointer && !isMobileUA;
}

export function getDeviceType() {
  const ua = navigator.userAgent;

  const isWindows = /Windows NT/i.test(ua);
  const isMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints === 1;
  const isIPadOS = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  const isIOS = /iPhone|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);

  if (isWindows || isMac) return 'PC';
  if (isIPadOS) return 'Tablet';
  if (isIOS || isAndroid) return 'Mobile';

  return 'Unknown';
}
