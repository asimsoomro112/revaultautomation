import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ReVault Admin",
  description: "Review queue and operations dashboard for the ReVault DM-to-Post bot.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0e13" }}>{children}</body>
    </html>
  );
}
