import { createCanvas, loadImage, GlobalFonts, Image } from '@napi-rs/canvas';
import path from 'path';
import { ASSETS_PATH } from '../utils/EamuseIO';
import { loadJacketWithCache, loadManyJackets } from './jacket_cache';

// Helper fonts for Windows to support Japanese text
const FONT_FAMILY = '"Outfit", "Segoe UI", "Meiryo", "Yu Gothic", "MS PGothic", sans-serif';

// Colors from RyuNET modern.css and score_modal.css
const COLORS = {
  bg0: '#050712',
  bg1: '#0b1220',
  panel: 'rgba(255, 255, 255, 0.06)',
  panel2: 'rgba(255, 255, 255, 0.085)',
  border: 'rgba(255, 255, 255, 0.12)',
  text: 'rgba(255, 255, 255, 0.92)',
  muted: 'rgba(255, 255, 255, 0.68)',
  accent: '#8b5cf6',
  info: '#38bdf8',
  
  // Judgements
  scrit: '#ffe600',
  crit: '#ffaa00',
  near: '#44ffcc',
  error: '#ff3344',
  exscore: '#ffcc44',
  maxchain: '#44ffcc',
  
  // Header / Body
  headerGradientStart: '#1c1c2e',
  headerGradientEnd: '#12121e',
  bodyGradientStart: '#0f0f1a',
  bodyGradientEnd: '#0a0a12',
  judgementBoxBg: 'rgba(0,0,0,0.4)',
  judgementBoxBorder: 'rgba(255,255,255,0.05)'
};

// Rank Gradients (S, AAA, etc)
function getRankGradient(ctx: any, grade: string, y1: number, y2: number) {
  const grad = ctx.createLinearGradient(0, y1, 0, y2);
  switch (grade) {
    case 'S':
      grad.addColorStop(0, '#ffe066'); grad.addColorStop(1, '#ffaa00'); break;
    case 'AAA+':
      grad.addColorStop(0, '#ff88cc'); grad.addColorStop(1, '#cc44aa'); break;
    case 'AAA':
      grad.addColorStop(0, '#bb88ff'); grad.addColorStop(1, '#7733cc'); break;
    case 'AA+':
    case 'AA':
      grad.addColorStop(0, '#66aaff'); grad.addColorStop(1, '#2255cc'); break;
    case 'A+':
    case 'A':
      grad.addColorStop(0, '#66ffdd'); grad.addColorStop(1, '#00aa88'); break;
    default:
      grad.addColorStop(0, '#dddddd'); grad.addColorStop(1, '#888888'); break;
  }
  return grad;
}

// Jacket drawing with placeholder fallback (cached loads — see jacket_cache.ts)
function drawJacket(
  ctx: any,
  img: Image | null,
  x: number,
  y: number,
  size: number,
  radius: number,
  placeholderColor: string
) {
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, radius);
    ctx.clip();
    ctx.drawImage(img, x, y, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = placeholderColor;
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, radius);
    ctx.fill();
  }
}

export async function renderRecentScore(play: any, profile: any): Promise<Buffer> {
  const width = 800;
  const headerHeight = 120;
  const bodyHeight = 220;
  const height = headerHeight + bodyHeight; // 340 total
  
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // --- Header Background ---
  const headerGrad = ctx.createLinearGradient(0, 0, width, headerHeight);
  headerGrad.addColorStop(0, COLORS.headerGradientStart);
  headerGrad.addColorStop(1, COLORS.headerGradientEnd);
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, width, headerHeight);
  
  // Header Bottom Border
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, headerHeight - 1, width, 1);

  // --- Body Background ---
  const bodyGrad = ctx.createLinearGradient(0, headerHeight, 0, height);
  bodyGrad.addColorStop(0, COLORS.bodyGradientStart);
  bodyGrad.addColorStop(1, COLORS.bodyGradientEnd);
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(0, headerHeight, width, bodyHeight);

  // --- Header Content ---
  // Jacket
  const jX = 24, jY = 24, jSize = 72;
  const jacketImg = await loadJacketWithCache(play.jacketUrl);
  drawJacket(ctx, jacketImg, jX, jY, jSize, jSize, '#111');
  // Jacket border
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(jX, jY, jSize, jSize);

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 24px ${FONT_FAMILY}`;
  ctx.fillText(play.title || 'Unknown Song', jX + jSize + 16, jY + 22);

  // Diff Badge
  const diffText = play.diff || 'MXM';
  ctx.font = `700 12px ${FONT_FAMILY}`;
  const diffWidth = ctx.measureText(diffText).width;
  const badgeWidth = Math.max(44, diffWidth + 12); // Dynamic width based on text

  const diffBadgeBg = 'rgba(255,255,255,0.12)';
  const diffBadgeBorder = 'rgba(255,255,255,0.2)';
  
  ctx.fillStyle = diffBadgeBg;
  ctx.beginPath();
  ctx.roundRect(jX + jSize + 16, jY + 36, badgeWidth, 20, 4);
  ctx.fill();
  ctx.strokeStyle = diffBadgeBorder;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(diffText, jX + jSize + 16 + (badgeWidth / 2), jY + 50);
  ctx.textAlign = 'left';

  // Played By
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `500 12px ${FONT_FAMILY}`;
  ctx.fillText(`Played by`, jX + jSize + 16, jY + 70);
  
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `700 12px ${FONT_FAMILY}`;
  ctx.fillText(profile.name, jX + jSize + 16 + 58, jY + 70);

  // RyuNET Watermark in header
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = `600 12px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.fillText('RyuNET', width - 24, 40);
  ctx.textAlign = 'left';

  try {
    const logoImg = await loadImage(path.join(ASSETS_PATH, 'static', 'img', 'logo.png'));
    // Draw the logo centered below the text
    // "RyuNET" text is right-aligned at width - 24, ending around width - 24, width is ~45px.
    // Let's place it at x = width - 65, y = 48, size 40x40
    ctx.drawImage(logoImg, width - 65, 48, 40, 40);
  } catch(e) {}

  // --- Body Content ---

  // Rank Glow (Left side)
  ctx.fillStyle = 'rgba(255, 170, 0, 0.05)'; // subtle glow
  ctx.beginPath();
  ctx.arc(100, headerHeight + 110, 70, 0, Math.PI * 2);
  ctx.fill();

  // Rank Letter
  const grade = play.gradeText || 'S';
  ctx.font = `900 italic 90px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = getRankGradient(ctx, grade, headerHeight + 60, headerHeight + 160);
  ctx.shadowColor = 'rgba(255,170,0,0.3)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.fillText(grade, 100, headerHeight + 140);
  ctx.shadowColor = 'transparent'; // reset

  // Score Number
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.font = `200 58px ${FONT_FAMILY}`;
  ctx.fillText(Number(play.score || 0).toLocaleString(), 200, headerHeight + 90);

  // Meta stats (EX Score / Max Combo)
  ctx.font = `600 10px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('EX SCORE', 205, headerHeight + 140);
  ctx.fillText('MAX COMBO', 305, headerHeight + 140);

  ctx.font = `700 22px ${FONT_FAMILY}`;
  ctx.fillStyle = COLORS.exscore;
  ctx.fillText(Number(play.exscore || 0).toLocaleString(), 205, headerHeight + 165);
  
  ctx.fillStyle = COLORS.maxchain;
  ctx.fillText(Number(play.maxChain || 0).toLocaleString(), 305, headerHeight + 165);

  // --- Judgements Box (Right side) ---
  const boxX = 540;
  const boxY = headerHeight + 20;
  const boxW = 236;
  const boxH = 175;

  ctx.fillStyle = COLORS.judgementBoxBg;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 10);
  ctx.fill();
  ctx.strokeStyle = COLORS.judgementBoxBorder;
  ctx.stroke();

  // Judgements Title
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = `600 10px ${FONT_FAMILY}`;
  ctx.fillText('JUDGEMENTS', boxX + 18, boxY + 24);
  
  // Separator
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(boxX + 18, boxY + 32, boxW - 36, 1);

  const jLabels = ['S-CRITICAL', 'CRITICAL', 'NEAR', 'ERROR'];
  const jColors = [COLORS.scrit, COLORS.crit, COLORS.near, COLORS.error];
  const jVals = [
    play.s_critical || play.just || 0,
    play.critical || 0,
    play.near || 0,
    play.error || 0
  ];

  for (let i = 0; i < 4; i++) {
    const y = boxY + 65 + (i * 30);
    
    // Dot
    ctx.fillStyle = jColors[i];
    ctx.beginPath();
    ctx.arc(boxX + 22, y - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    
    // Label
    ctx.font = `700 12px ${FONT_FAMILY}`;
    ctx.fillText(jLabels[i], boxX + 34, y);

    // Value
    ctx.font = `700 18px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.fillText(Number(jVals[i]).toLocaleString(), boxX + boxW - 18, y + 2);
    ctx.textAlign = 'left';
  }

  return await canvas.encode('png');
}

export async function renderB50(plays: any[], profile: any, volforce: number): Promise<Buffer> {
  const width = 1200;
  const cols = 5;
  const rows = Math.ceil(plays.length / cols);
  const startY = 120;
  const rowHeight = 110;
  const height = startY + rows * rowHeight + 30;
  
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, COLORS.bg1);
  gradient.addColorStop(1, COLORS.bg0);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Header
  ctx.fillStyle = COLORS.text;
  ctx.font = `800 32px ${FONT_FAMILY}`;
  ctx.fillText(`${profile.name} VF TOP 50`, 30, 50);
  
  ctx.fillStyle = COLORS.accent;
  ctx.font = `700 24px ${FONT_FAMILY}`;
  ctx.fillText(`${volforce.toFixed(3)} VF`, 30, 85);

  // Watermark
  ctx.fillStyle = COLORS.muted;
  ctx.font = `600 14px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.fillText('RyuNET', width - 30, 50);
  ctx.textAlign = 'left';

  try {
    const logoImg = await loadImage(path.join(ASSETS_PATH, 'static', 'img', 'logo.png'));
    ctx.drawImage(logoImg, width - 80, 60, 50, 50);
  } catch(e) {}

  // Preload all jackets in parallel (cached, concurrency-capped) so the draw
  // loop below never stalls on sequential network round-trips.
  const jacketImages = await loadManyJackets(plays.map(p => p.jacketUrl));

  // Draw Grid
  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 30 + col * 230;
    const y = startY + row * rowHeight;

    // Card background
    ctx.fillStyle = COLORS.panel;
    ctx.beginPath();
    ctx.roundRect(x, y, 220, 100, 8);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.stroke();

    // Rank index (01, 02) watermark inside card
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.font = `800 50px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(i + 1).padStart(2, '0'), x + 210, y + 80);
    ctx.textAlign = 'left';

    // Jacket
    const jSize = 50;
    const jacketImg = jacketImages.get(play.jacketUrl) || null;
    drawJacket(ctx, jacketImg, x + 10, y + 10, jSize, jSize, COLORS.panel2);
    if (jacketImg) {
      ctx.strokeStyle = COLORS.border;
      ctx.strokeRect(x + 10, y + 10, jSize, jSize);
    }

    // Title truncate
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 14px ${FONT_FAMILY}`;
    const title = (play.title || '').length > 18 ? (play.title.substring(0, 16) + '...') : play.title;
    ctx.fillText(title, x + 70, y + 25);

    // Score
    ctx.font = `700 20px ${FONT_FAMILY}`;
    ctx.fillText(Number(play.score || 0).toLocaleString(), x + 70, y + 85);

    // Diff / Level badge
    const diffText = play.diff || 'MXM';
    ctx.font = `700 10px ${FONT_FAMILY}`;
    const diffWidth = ctx.measureText(diffText).width;
    const badgeW = Math.max(36, diffWidth + 10);
    
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.roundRect(x + 70, y + 40, badgeW, 18, 3);
    ctx.fill();
    
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(diffText, x + 70 + (badgeW / 2), y + 53);

    // VF contribution badge
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.roundRect(x + 70 + badgeW + 6, y + 40, 42, 18, 3);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.stroke();

    ctx.fillStyle = COLORS.info;
    ctx.fillText(Number(play.volforce / 1000).toFixed(3), x + 70 + badgeW + 6 + 21, y + 53);
    ctx.textAlign = 'left';
  }

  return await canvas.encode('png');
}
