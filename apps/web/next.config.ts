import type { NextConfig } from "next";
const nextConfig:NextConfig={
  reactStrictMode:true,
  transpilePackages:["@youngkingz/ui","@youngkingz/contracts"],
  // QA local: el browser se conecta por 127.0.0.1; Next 16 exige declarar
  // explícitamente el origen o no hidrata los componentes cliente.
  allowedDevOrigins:["127.0.0.1","localhost"]
};
export default nextConfig;
