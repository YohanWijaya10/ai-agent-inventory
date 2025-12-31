import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Inventory Health Dashboard',
  description: 'Inventory health insights dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          {children}
        </div>
      </body>
    </html>
  )
}

