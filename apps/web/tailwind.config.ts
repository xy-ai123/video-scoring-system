import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        brand: {
          50: "#f5f7ff",
          100: "#e8edff",
          500: "#5b6cff",
          600: "#4453ee",
          700: "#3540c4",
        },
      },
    },
  },
  plugins: [],
};

export default config;
