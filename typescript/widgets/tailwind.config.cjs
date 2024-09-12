/** @type {import('tailwindcss').Config} */

const defaultTheme = require('tailwindcss/defaultTheme')

module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  prefix: 'htw-',
  theme: {
    fontFamily: {
      sans: ['Helvetica', 'Arial', 'sans-serif'],
      serif: ['Garamond', 'serif'],
      mono: ['Courier New', 'monospace'],
    },
    screens: {
      xs: '480px',
      ...defaultTheme.screens,
    },
    extend: {
      colors: {
        black: '#010101',
        white: '#ffffff',
        blue: {
          50: '#E6EDF9',
          100: '#CDDCF4',
          200: '#A7C2EC',
          300: '#82A8E4',
          400: '#5385D2',
          500: '#2362C0',
          600: '#1D4685',
          700: '#162A4A',
          800: '#11213B',
          900: '#0D192C',
        },
        beige: {
          100: '#F6F4F1',
          200: '#F5F2EF',
          300: '#F3F0ED',
          400: '#F2EEEB',
          500: '#F1EDE9',
          600: '#D8D5D1',
          700: '#C0BDBA',
          800: '#A8A5A3',
          900: '#908E8B',
        },
        red: {
          100: '#EBBAB8',
          200: '#DF8D8A',
          300: '#D25F5B',
          400: '#C5312C',
          500: '#BF1B15',
          600: '#AB1812',
          700: '#85120E',
          800: '#5F0D0A',
          900: '#390806',
        },
        green: {
          50: '#D3E3DB',
          100: '#BED5C9',
          200: '#93BAA6',
          300: '#679F82',
          400: '#3C835E',
          500: '#27764d',
          600: '#236A45',
          700: '#1F5E3D',
          800: '#17462E',
          900: '#0F2F1E',
        },
        pink: {
          50: '#FAEAF7',
          100: '#F0C0E8',
          200: '#EBABE0',
          300: '#E282D1',
          400: '#D858C2',
          500: '#CF2FB3',
          600: '#BA2AA1',
          700: '#A5258F',
          800: '#90207D',
          900: '#7C1C6B',
        }
      },
      fontSize: {
        md: '0.95rem',
      },
      spacing: {
        88: '22rem',
        100: '26rem',
        112: '28rem',
        128: '32rem',
        144: '36rem',
      },
      borderRadius: {
        none: '0',
        sm: '0.2rem',
        DEFAULT: '0.3rem',
        md: '0.4rem',
        lg: '0.5rem',
        full: '9999px',
      },
      blur: {
        xs: '3px',
      },
      animation: {
        'pulse-slow': 'pulse 3s infinite cubic-bezier(.4,0,.6,1)',
      }
    },
  },
  plugins: [],
};
