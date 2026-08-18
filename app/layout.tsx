import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'TREDECIM, bitemporal agent memory',
  description:
    'Facts carry validity intervals, so an agent knows not just what is true, but when it was true and when it learned it.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
