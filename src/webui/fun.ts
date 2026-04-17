import { Router } from 'express';
import open from 'open';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { promises as fsp } from 'fs';
import { PLUGIN_PATH, SAVE_PATH } from '../utils/EamuseIO';

export const fun = Router();

fun.get('/open-plugins', async (req, res) => {
  if (req.ip == '127.0.0.1' || req.ip == '::1') {
    open(PLUGIN_PATH);
  }
  res.sendStatus(200);
});

fun.get('/ping', async (req, res) => {
  res.json('pong');
});

fun.get('/shutdown', async (req, res) => {
  process.exit(0);
});

fun.get('/backup-savedata', async (req, res) => {
  if (!req.session.user?.admin) {
    return res.sendStatus(403);
  }

  try {
    const backupDir = path.join(path.dirname(SAVE_PATH), 'backup');
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }

    const now = new Date();
    const timestamp = now.toISOString().replace(/[T]/g, '_').replace(/[:]/g, '-').split('.')[0];
    const destPath = path.join(backupDir, `savedata_${timestamp}`);

    await fsp.cp(SAVE_PATH, destPath, { recursive: true });
    res.json({ success: true, path: `backup/savedata_${timestamp}` });
  } catch (err) {
    console.error('Backup failed:', err);
    res.status(500).json({ success: false, error: 'Backup failed' });
  }
});
