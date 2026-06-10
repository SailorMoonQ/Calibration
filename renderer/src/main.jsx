import { createRoot } from 'react-dom/client';
import './i18n';
import { App } from './App.jsx';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')).render(<App />);
