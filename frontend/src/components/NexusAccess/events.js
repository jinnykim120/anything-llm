// [NEXUS 폴더 잠금] 폴더를 열고 닫거나 관리자 로그인 상태가 바뀌었음을 화면 곳곳에 알린다.
export const NEXUS_ACCESS_CHANGED_EVENT = "nexus-access-changed";

export function notifyNexusAccessChanged() {
  window.dispatchEvent(new Event(NEXUS_ACCESS_CHANGED_EVENT));
}
