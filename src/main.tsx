import { createRoot } from 'react-dom/client';
import { migrateStorageKeys } from './lib/storage-keys';
import { App } from './App';
import './index.css';

migrateStorageKeys();
createRoot(document.getElementById('root')!).render(<App />);
