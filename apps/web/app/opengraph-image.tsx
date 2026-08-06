import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FAF6EF',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <svg width={72} height={72} viewBox="0 0 40 40" fill="none">
            <rect width="40" height="40" rx="10" fill="#0D948826" />
            <path
              d="M6 20C6 20 12 10 20 10C28 10 34 20 34 20C34 20 28 30 20 30C12 30 6 20 6 20Z"
              fill="none"
              stroke="#0D9488"
              strokeWidth="2.4"
              strokeLinejoin="round"
            />
            <path
              d="M14 21L18 16L22 20L27 13"
              stroke="#0D9488"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span style={{ fontSize: 72, fontWeight: 600, color: '#24211D', letterSpacing: '-1px' }}>
            Tellsight
          </span>
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: '#6B655C', marginTop: 24 }}>
          Your spreadsheet, actually explained
        </div>
      </div>
    ),
    { ...size },
  );
}
