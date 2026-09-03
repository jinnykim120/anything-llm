import { Moon, Sun } from "@phosphor-icons/react";
import { useThemeContext } from "@/ThemeContext";

/** A small, persistent light/dark switch shared by the landing and workbench. */
export default function ThemeToggle() {
  const { isLight, setTheme } = useThemeContext();
  const nextTheme = isLight ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label={isLight ? "다크 테마로 전환" : "라이트 테마로 전환"}
      title={isLight ? "다크 테마" : "라이트 테마"}
      className="fixed bottom-5 right-5 z-[80] inline-flex h-10 items-center gap-2 rounded-full border border-slate-300 bg-white/90 px-3 text-xs font-medium text-slate-700 shadow-sm backdrop-blur transition hover:border-blue-500 hover:text-blue-700 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200"
    >
      {isLight ? (
        <Moon size={16} weight="bold" />
      ) : (
        <Sun size={16} weight="bold" />
      )}
      <span>{isLight ? "다크" : "라이트"}</span>
    </button>
  );
}
