module.exports = {
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      colors: {
        ocean: { 950: '#061525', 900: '#0a2744', 800: '#0f3a5f', 700: '#155a8a', 500: '#1d8fbf', 300: '#7ec8e3' },
        gold:  { 400: '#f5c542', 500: '#e8b020', 600: '#c9940a' },
        sand:  { 50: '#f7f3ea', 100: '#efe6d4' }
      },
      fontFamily: {
        display: ['"Segoe UI"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      }
    }
  }
};
