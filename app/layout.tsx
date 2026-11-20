import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vitrine — Video Commerce Engine",
  description: "Crie vídeos de produto prontos para vender em poucos minutos.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
