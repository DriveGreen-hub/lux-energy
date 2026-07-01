import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // During local dev, run `vercel dev` alongside this, or point
      // VITE_API_BASE at your deployed API instead.
      "/api": "http://localhost:3000",
    },
  },
});
