import type { Metadata } from "next";
import "./globals.css";

export const metadata:Metadata={title:"Young Kingz · Staff y Cliente",description:"Identidad segura para clientes y equipos YoungKingZ"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="es"><body>{children}</body></html>;}
