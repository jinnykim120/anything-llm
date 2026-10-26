// [NEXUS 폴더 잠금] 로그인이 없으므로 브라우저가 만든 임의의 ID 를 "사용자"로 쓴다.
// 서버는 이 ID 로 (1) 비밀번호로 연 폴더, (2) 내 대화·스레드를 구분한다.
// 브라우저 저장소를 지우거나 다른 기기로 접속하면 다른 사용자로 보인다.
import { API_BASE } from "@/utils/constants";

const STORAGE_KEY = "nexus_client_id";
let memoryId = null;

function randomId() {
  const bytes = new Uint8Array(24);
  // crypto.randomUUID 는 https/localhost 에서만 되므로 getRandomValues 를 쓴다.
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getClientId() {
  if (memoryId) return memoryId;
  try {
    let id = window.localStorage.getItem(STORAGE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = randomId();
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    memoryId = id;
  } catch {
    // 저장소가 막힌 환경(시크릿 창 등): 이 탭이 열려 있는 동안만 유지한다.
    memoryId = randomId();
  }
  return memoryId;
}

/** 헤더를 못 붙이는 URL(<iframe>, <a href>, window.open)용: 쿼리로 ID 를 붙인다. */
export function withClientParam(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cid=${encodeURIComponent(getClientId())}`;
}

/**
 * 관리자 콘솔·설정 화면인가. 이 화면들의 요청에만 X-Nexus-Console 헤더를 붙여서
 * 서버가 관리자 권한을 적용한다 — 평소 화면에서는 관리자도 일반 사용자처럼 동작한다.
 */
export function isConsolePath(pathname = window.location.pathname) {
  return (
    pathname.startsWith("/nexus-admin") ||
    // 분류 검수는 일반 사용자의 평소 작업이라 관리자 권한을 쓰지 않는다.
    (pathname.startsWith("/settings") &&
      !pathname.startsWith("/settings/classification")) ||
    /^\/workspace\/[^/]+\/(settings|affinity|usage)(\/|$)/.test(pathname)
  );
}

export const ADMIN_LOGIN_PATH = "/nexus-admin";

/** API 로 가는 모든 fetch(스트리밍 포함)에 X-Nexus-Client 헤더를 붙인다. */
export function installNexusFetch() {
  if (typeof window === "undefined" || window.__nexusFetchInstalled) return;
  window.__nexusFetchInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (url && String(url).startsWith(API_BASE)) {
        const headers = new Headers(
          init.headers ||
            (typeof input === "string" ? undefined : input.headers)
        );
        headers.set("X-Nexus-Client", getClientId());
        const consolePage = isConsolePath();
        if (consolePage) headers.set("X-Nexus-Console", "1");
        const promise = original(input, { ...init, headers });
        if (!consolePage) return promise;
        // 콘솔을 쓰는 중에 관리자 로그인이 만료되면 로그인 화면으로 보낸다.
        return promise.then((response) => {
          if (
            response.status === 403 &&
            !window.location.pathname.startsWith(ADMIN_LOGIN_PATH)
          ) {
            response
              .clone()
              .json()
              .then((body) => {
                if (body?.needsAdmin)
                  window.location.assign(
                    `${ADMIN_LOGIN_PATH}?next=${encodeURIComponent(window.location.pathname)}`
                  );
              })
              .catch(() => {});
          }
          return response;
        });
      }
    } catch {
      /* 헤더를 못 붙여도 요청은 그대로 보낸다 */
    }
    return original(input, init);
  };
}
