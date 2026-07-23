/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        app: "var(--color-bg)",
        surface: "var(--color-surface)",
        fg: "var(--color-text)",
        muted: "var(--color-text-muted)",
        brand: {
          DEFAULT: "var(--color-primary)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
        },
        success: "var(--color-success)",
        danger: "var(--color-danger)",
        warning: "var(--color-warning)",
      },
      borderColor: {
        DEFAULT: "var(--color-border)",
      },
    },
  },
  plugins: [],
};
