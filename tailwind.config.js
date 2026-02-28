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
        primary: '#4A90E2',
        registry: '#E67E22',
        success: '#4CAF50',
        danger: '#F44336',
        warning: '#FF9800',
        solar: {
          favorable: '#2E7D32',
          neutral: '#1565C0',
          restricted: '#C62828',
        },
      },
    },
  },
  plugins: [],
};
