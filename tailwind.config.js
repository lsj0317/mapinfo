/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './App.{js,jsx,ts,tsx}',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        background: '#FAFAFA',
        foreground: '#09090B',
        card: '#FFFFFF',
        'card-foreground': '#09090B',
        primary: '#18181B',
        'primary-foreground': '#FAFAFA',
        secondary: '#F4F4F5',
        'secondary-foreground': '#18181B',
        muted: '#F4F4F5',
        'muted-foreground': '#71717A',
        accent: '#F4F4F5',
        'accent-foreground': '#18181B',
        destructive: '#DC2626',
        border: '#E4E4E7',
        input: '#E4E4E7',
        ring: '#18181B',
        registry: '#18181B',
        success: '#18181B',
        danger: '#DC2626',
        warning: '#18181B',
        solar: {
          favorable: '#18181B',
          neutral: '#52525B',
          restricted: '#DC2626',
        },
      },
    },
  },
  plugins: [],
};
