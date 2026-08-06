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
            <rect x="6" y="21" width="6" height="11" rx="1.8" fill="#0D9488" opacity="0.55" />
            <rect x="15" y="14" width="6" height="18" rx="1.8" fill="#0D9488" opacity="0.85" />
            <path
              d="M23 22L28.5 27.5L38 15"
              stroke="#0D9488"
              strokeWidth="4"
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
