import type { NextConfig } from "next";

const defaultAllowedDevOrigins = ["100.64.1.68", "100.64.1.68:3000"];

const allowedDevOrigins = [
  ...defaultAllowedDevOrigins,
  ...(process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
};

export default nextConfig;
