export const words = [
  { text: 'Hello', startMs: 120, endMs: 410, speakerId: 'Ana' },
  { text: ',', startMs: 410, endMs: 450, speakerId: 'Ana' },
  { text: 'there!', startMs: 450, endMs: 910, speakerId: 'Ana' },
  { text: '你好', startMs: 1200, endMs: 1490, speakerId: 'Bo' },
  { text: '。', startMs: 1490, endMs: 1510, speakerId: 'Bo' },
];

export const expectedSrt = '1\r\n00:00:00,120 --> 00:00:00,910\r\nHello, there!\r\n\r\n2\r\n00:00:01,200 --> 00:00:01,510\r\n你好。\r\n';
