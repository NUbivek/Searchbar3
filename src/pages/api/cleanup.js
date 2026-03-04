import fs from 'fs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { filePath } = payload;

    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({
        error: 'filePath is required'
      });
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(200).json({
      status: 'fail-soft',
      success: false,
      degradedSources: ['cleanup'],
      error: 'Cleanup failed'
    });
  }
}
