import { createContext, useEffect, useState } from "react";
import BrandMarkLight from "./media/logo/document-expansion-llm.svg"; // light text — for dark UI
import BrandMarkDark from "./media/logo/document-expansion-llm-dark.svg"; // dark text — for light UI
import System from "./models/system";

export const REFETCH_LOGO_EVENT = "refetch-logo";

function isLightMode() {
  return document.documentElement.getAttribute("data-theme") === "light";
}

/** The bundled Document Expansion LLM wordmark for the active theme. */
function brandMark() {
  return isLightMode() ? BrandMarkDark : BrandMarkLight;
}

export const LogoContext = createContext();

export function LogoProvider({ children }) {
  const [logo, setLogo] = useState("");
  const [loginLogo, setLoginLogo] = useState("");
  const [isCustomLogo, setIsCustomLogo] = useState(false);

  async function fetchInstanceLogo() {
    try {
      const { isCustomLogo, logoURL } = await System.fetchLogo();
      // Only an admin-uploaded logo overrides the bundled brand mark; the
      // stock server asset is ignored so the product keeps its identity.
      if (isCustomLogo && logoURL) {
        setLogo(logoURL);
        setLoginLogo(logoURL);
        setIsCustomLogo(true);
        return;
      }
    } catch (err) {
      console.error("Failed to fetch logo:", err);
    }
    setLogo(brandMark());
    setLoginLogo(brandMark());
    setIsCustomLogo(false);
  }

  useEffect(() => {
    fetchInstanceLogo();
    window.addEventListener(REFETCH_LOGO_EVENT, fetchInstanceLogo);
    return () => {
      window.removeEventListener(REFETCH_LOGO_EVENT, fetchInstanceLogo);
    };
  }, []);

  return (
    <LogoContext.Provider value={{ logo, setLogo, loginLogo, isCustomLogo }}>
      {children}
    </LogoContext.Provider>
  );
}
