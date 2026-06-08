const JUNK_PATTERNS = /^[*•·\s]*(no\b|tajuk|jenis|tarikh|status|tindakan|actions?|type|title|ref|tekan\s*(sini|here)|click\s*here|log\s*masuk|login|email|kata\s*laluan|password|search\s*(for|title)|record\(s\)\s*found|available\s*tender|posted\s*date|closing\s*date|sebutharga$|tender$|no\.\s*$|[-–—]+$|\d+\s*\.\s*$|tutup|buka|daftar|laman|halaman|sila\s|hubungi|maklumat\s*lanjut|klik\s*sini)/i;

// Reject strings that look like times/office hours
const TIME_PATTERN = /^\d{1,2}[.:]\d{2}\s*(pagi|petang|tengah|malam|am|pm)/i;

// Reject strings that are mostly numbers/punctuation
const MOSTLY_DIGITS = /^[\d\s\/\-\.,:()]+$/;

// Reject navigation strings with pipe separators like "Iklan Semasa | Keputusan |"
const NAV_PIPES = /\w\s*\|\s*\w/;

// Reject "subscribe to receive..." type strings
const SUBSCRIBE_PATTERN = /^subscribe\b/i;

const MIN_TITLE_LEN = 15;

function isValidTitle(title) {
  if (!title) return false;
  const t = title.trim();
  if (t.length < MIN_TITLE_LEN) return false;
  if (JUNK_PATTERNS.test(t)) return false;
  if (TIME_PATTERN.test(t)) return false;
  if (MOSTLY_DIGITS.test(t)) return false;
  if (NAV_PIPES.test(t)) return false;
  if (SUBSCRIBE_PATTERN.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length <= 2 && t === t.toUpperCase()) return false;
  return true;
}

function parseDate(raw) {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
  s = s.replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$2-$1');
  const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
  const m = s.match(/(\d{1,2})\s+([a-z]{3})\w*\s+(\d{4})/i);
  if (m) {
    const mo = months[m[2].toLowerCase().slice(0,3)];
    if (mo) s = `${m[3]}-${mo}-${m[1].padStart(2,'0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return s.slice(0, 10);
  }
  return null;
}

function inferStatus(openDate, deadline) {
  const today = new Date().toISOString().slice(0, 10);
  if (deadline && deadline < today) return 'overdue';
  if (openDate && openDate > today) return 'upcoming';
  return 'active';
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = { isValidTitle, parseDate, inferStatus, nowIso };
