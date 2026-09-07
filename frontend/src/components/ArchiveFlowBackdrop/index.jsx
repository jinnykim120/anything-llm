import { useId } from "react";

const NODES = [
  { x: 126, y: 136, radius: 52, color: "#f6c84c" },
  { x: 112, y: 322, radius: 58, color: "#63d9ad" },
  { x: 138, y: 500, radius: 54, color: "#f1787e" },
  { x: 276, y: 624, radius: 46, color: "#4ac7c6" },
];

const STREAMS = [
  ["M 164 112 C 320 50 486 120 930 74", "#f6c84c"],
  ["M 164 132 C 340 86 520 166 944 136", "#a9a7ff"],
  ["M 164 152 C 360 130 534 212 928 208", "#4ac7c6"],
  ["M 152 300 C 344 244 510 286 946 246", "#63d9ad"],
  ["M 152 322 C 350 286 542 350 950 320", "#f1787e"],
  ["M 152 344 C 344 334 560 402 944 398", "#f6c84c"],
  ["M 174 480 C 346 430 524 474 940 454", "#f1787e"],
  ["M 174 502 C 370 472 570 530 936 532", "#4ac7c6"],
  ["M 174 524 C 364 518 568 584 916 612", "#a9a7ff"],
  ["M 310 606 C 458 544 626 620 924 680", "#63d9ad"],
  ["M 310 624 C 496 594 666 676 892 716", "#f6c84c"],
];

const BUBBLES = [
  [548, 120, 58, "#f6c84c"],
  [654, 138, 88, "#63d9ad"],
  [792, 108, 48, "#a9a7ff"],
  [520, 254, 46, "#f1787e"],
  [644, 260, 94, "#4ac7c6"],
  [796, 238, 68, "#63d9ad"],
  [904, 272, 42, "#f6c84c"],
  [554, 408, 76, "#a9a7ff"],
  [700, 398, 104, "#f1787e"],
  [852, 414, 58, "#4ac7c6"],
  [536, 548, 58, "#63d9ad"],
  [668, 558, 88, "#f6c84c"],
  [824, 564, 72, "#a9a7ff"],
];

export default function ArchiveFlowBackdrop({ className = "" }) {
  const id = useId().replace(/:/g, "");

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden opacity-[0.08] dark:opacity-[0.18] ${className}`}
    >
      <svg
        viewBox="0 0 1000 720"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
      >
        <defs>
          <radialGradient id={`${id}-halo`} cx="68%" cy="50%" r="68%">
            <stop offset="0" stopColor="#40aeb1" stopOpacity="0.48" />
            <stop offset="0.3" stopColor="#1d7781" stopOpacity="0.3" />
            <stop offset="0.72" stopColor="#12485b" stopOpacity="0.11" />
            <stop offset="1" stopColor="#061321" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-bubble`} cx="30%" cy="25%" r="78%">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.26" />
            <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.04" />
            <stop offset="1" stopColor="#061321" stopOpacity="0.1" />
          </radialGradient>
          <filter
            id={`${id}-glow`}
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
          >
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <ellipse
          cx="620"
          cy="360"
          rx="440"
          ry="350"
          fill={`url(#${id}-halo)`}
        />

        <g fill="none" stroke="#8de8e4" strokeOpacity="0.17">
          <ellipse cx="688" cy="360" rx="256" ry="308" strokeWidth="1" />
          <ellipse
            cx="688"
            cy="360"
            rx="188"
            ry="242"
            strokeWidth="0.8"
            strokeDasharray="2 15"
          />
        </g>

        <g>
          {BUBBLES.map(([x, y, radius, color], index) => (
            <g key={`backdrop-bubble-${index}`}>
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={color}
                fillOpacity="0.24"
                stroke={color}
                strokeOpacity="0.28"
                strokeWidth="1"
              />
              <circle
                cx={x - radius * 0.2}
                cy={y - radius * 0.2}
                r={radius * 0.8}
                fill={`url(#${id}-bubble)`}
                opacity="0.5"
              />
            </g>
          ))}
        </g>

        <g
          fill="none"
          strokeLinecap="round"
          opacity="0.76"
          filter={`url(#${id}-glow)`}
        >
          {STREAMS.map(([d, color], index) => (
            <path
              key={`backdrop-stream-${index}`}
              d={d}
              stroke={color}
              strokeWidth={index % 4 === 0 ? 2.4 : 1.2}
              strokeOpacity="0.62"
            />
          ))}
        </g>

        <g filter={`url(#${id}-glow)`}>
          {NODES.map(({ x, y, radius, color }, index) => (
            <g key={`backdrop-node-${index}`}>
              <circle
                cx={x}
                cy={y}
                r={radius + 12}
                fill={color}
                fillOpacity="0.11"
              />
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={color}
                fillOpacity="0.72"
              />
              <circle
                cx={x}
                cy={y}
                r={radius * 0.24}
                fill="#071a29"
                fillOpacity="0.54"
              />
              <circle
                cx={x}
                cy={y}
                r={radius * 0.1}
                fill="#ffffff"
                fillOpacity="0.64"
              />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
