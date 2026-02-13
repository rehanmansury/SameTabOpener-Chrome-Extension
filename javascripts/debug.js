// debug.js - Debug logging system for SameTabOpener
class DebugLogger {
  constructor() {
    this.logs = [];
    this.maxLogs = 500;
    this.observers = new Set();
    this.debugEnabled = true; // Debug flag - can be toggled
  }

  log(...args) {
    if (!this.debugEnabled) return;
    
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    const logEntry = { 
      timestamp, 
      message,
      level: 'info'
    };
    
    this.addLogEntry(logEntry);
    console.log(`[${timestamp}]`, ...args);
  }

  error(...args) {
    if (!this.debugEnabled) return;
    
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      arg instanceof Error ? `${arg.message}\n${arg.stack}` :
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    const logEntry = {
      timestamp,
      message,
      level: 'error'
    };

    this.addLogEntry(logEntry);
    console.error(`[${timestamp}]`, ...args);
  }

  warn(...args) {
    if (!this.debugEnabled) return;
    
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    const logEntry = {
      timestamp,
      message,
      level: 'warn'
    };

    this.addLogEntry(logEntry);
    console.warn(`[${timestamp}]`, ...args);
  }

  addLogEntry(entry) {
    this.logs.unshift(entry);
    
    if (this.logs.length > this.maxLogs) {
      this.logs.length = this.maxLogs;
    }

    this.notifyObservers(entry);
  }

  clear() {
    this.logs = [];
    this.notifyObservers();
  }

  getLogs() {
    return [...this.logs];
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = enabled;
    this.log(`Debug logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  isDebugEnabled() {
    return this.debugEnabled;
  }

  addObserver(callback) {
    this.observers.add(callback);
    return () => this.observers.delete(callback);
  }

  notifyObservers(newEntry) {
    for (const observer of this.observers) {
      try {
        observer(newEntry, this.logs);
      } catch (e) {
        console.error('Error in debug log observer:', e);
      }
    }
  }
}

// Create a singleton instance
const debugLogger = new DebugLogger();

// Export for ES modules
export { debugLogger };
