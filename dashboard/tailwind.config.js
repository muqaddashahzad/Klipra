/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Klipra brand palette — warm charcoal + teal/cyan + coral accent
        background: "#0B0F14",   // slightly warmer than openshorts' #09090b
        surface: "#14181F",
        elevated: "#1B2028",
        border: "#252C36",
        // Primary remains 'primary' so existing components inherit cleanly,
        // but the hue shifts from openshorts blue to klipra teal.
        primary: {
          DEFAULT: "#0EA5A4",   // teal-500
          50:  "#F0FDFA",
          100: "#CCFBF1",
          200: "#99F6E4",
          300: "#5EEAD4",
          400: "#2DD4BF",
          500: "#14B8A6",
          600: "#0D9488",
          700: "#0F766E",
          800: "#115E59",
          900: "#134E4A",
        },
        // Accent stays as a single named color (used by lots of components)
        // — switched from violet to cyan to harmonize with primary.
        accent: {
          DEFAULT: "#06B6D4",   // cyan-500
          50:  "#ECFEFF",
          100: "#CFFAFE",
          400: "#22D3EE",
          500: "#06B6D4",
          600: "#0891B2",
          700: "#0E7490",
        },
        // Coral CTAs — used sparingly for the most important action.
        coral: {
          DEFAULT: "#F97316",
          400: "#FB923C",
          500: "#F97316",
          600: "#EA580C",
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        DEFAULT: "0.625rem",
        sm: "0.375rem",
        lg: "0.875rem",
        xl: "1.125rem",
        '2xl': "1.5rem",
      },
      boxShadow: {
        // Soft glow on focused / important elements.
        glow: "0 0 0 1px rgba(20, 184, 166, 0.4), 0 8px 32px -8px rgba(20, 184, 166, 0.4)",
        coral: "0 0 0 1px rgba(249, 115, 22, 0.4), 0 8px 32px -8px rgba(249, 115, 22, 0.4)",
      },
      backgroundImage: {
        'klipra-gradient': 'linear-gradient(135deg, #0EA5A4 0%, #06B6D4 50%, #22D3EE 100%)',
        'klipra-gradient-soft': 'linear-gradient(135deg, rgba(14,165,164,0.15) 0%, rgba(34,211,238,0.10) 100%)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      },
    },
  },
  plugins: [],
}
