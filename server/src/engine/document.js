
const SUBJECT_LINES = [
  'Your order has been shipped!',
  'Welcome to our platform',
  'Action required: verify your email',
  'Weekly digest for your account',
  'Important security update',
  'Your subscription is expiring soon',
  'New message from support',
  'Payment receipt for your recent purchase',
  'Invitation to join the beta program',
  'Reminder: upcoming scheduled maintenance',
  'Your monthly statement is ready',
  'Flash sale: 50% off everything',
  'Account activity alert',
  'Tips to get the most out of your account',
  'We miss you! Come back for a special offer',
  'Your referral reward is waiting',
  'New features just launched',
  'Complete your profile to unlock rewards',
  'Feedback request: how are we doing?',
  'Limited time offer just for you',
];

const STATUSES = ['delivered', 'read', 'unread'];

const BODY_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing',
  'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore',
  'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam',
  'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi',
  'aliquip', 'ex', 'ea', 'commodo', 'consequat', 'duis', 'aute', 'irure',
  'reprehenderit', 'voluptate', 'velit', 'esse', 'cillum', 'fugiat',
  'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat', 'cupidatat',
  'non', 'proident', 'sunt', 'culpa', 'qui', 'officia', 'deserunt',
  'mollit', 'anim', 'id', 'est', 'laborum', 'message', 'notification',
  'inbox', 'campaign', 'delivery', 'engagement', 'content', 'template',
  'priority', 'channel', 'metadata', 'tracking', 'analytics', 'segment',
  'audience', 'personalization', 'workflow', 'trigger', 'automation',
];

function randomHex(bytes) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < bytes * 2; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

function fastUUID() {
  // Fast non-crypto UUID v4
  const h = '0123456789abcdef';
  let u = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) u += '-';
    else if (i === 14) u += '4';
    else u += h[Math.floor(Math.random() * 16)];
  }
  return u;
}

function randomUserId(userPoolSize) {
  const num = 1 + Math.floor(Math.random() * userPoolSize);
  return `user_${String(num).padStart(6, '0')}`;
}

function randomSubject() {
  return SUBJECT_LINES[Math.floor(Math.random() * SUBJECT_LINES.length)];
}

function randomStatus() {
  return STATUSES[Math.floor(Math.random() * STATUSES.length)];
}

// Pre-generate a large padding string to slice from (avoids per-doc random loops)
const PADDING_BLOCK_SIZE = 64 * 1024; // 64 KB
let _paddingBlock = null;

function getPaddingBlock() {
  if (_paddingBlock) return _paddingBlock;
  const chunks = [];
  let size = 0;
  while (size < PADDING_BLOCK_SIZE) {
    const word = BODY_WORDS[Math.floor(Math.random() * BODY_WORDS.length)];
    chunks.push(word);
    size += word.length + 1;
  }
  _paddingBlock = chunks.join(' ').slice(0, PADDING_BLOCK_SIZE);
  return _paddingBlock;
}

function generateBodyText(targetBytes) {
  const block = getPaddingBlock();
  // Pick a random offset into the padding block for variety
  const maxOffset = block.length - targetBytes;
  const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
  return block.slice(offset, offset + targetBytes);
}

/**
 * Generate a single inbox message document.
 * @param {number} docSizeKB - Target document size in KB
 * @param {number} userPoolSize - Size of the user ID pool (1 to userPoolSize)
 * @returns {object} A document matching the inbox message schema
 */
// Cache skeleton overhead — it's roughly constant across docs (~250 bytes)
let _skeletonOverhead = 0;

export function generateDocument(docSizeKB = 1, userPoolSize = 100000) {
  const targetBytes = docSizeKB * 1024;

  const doc = {
    user_id: randomUserId(userPoolSize),
    msg_id: fastUUID(),
    campaign_id: `camp_${randomHex(3)}`,
    subject: randomSubject(),
    body: '',
    status: randomStatus(),
    created_at: new Date(),
    metadata: {
      channel: 'inbox',
      priority: 'normal',
      template_id: `tmpl_${randomHex(3)}`,
    },
  };

  // Compute skeleton overhead once, reuse thereafter
  if (_skeletonOverhead === 0) {
    _skeletonOverhead = JSON.stringify(doc).length;
  }

  const bodyTargetBytes = Math.max(0, targetBytes - _skeletonOverhead);
  doc.body = generateBodyText(bodyTargetBytes);

  return doc;
}

/**
 * Generate an array of inbox message documents.
 * @param {number} count - Number of documents to generate
 * @param {number} docSizeKB - Target document size in KB
 * @param {number} userPoolSize - Size of the user ID pool
 * @returns {object[]} Array of documents
 */
export function generateDocuments(count, docSizeKB = 1, userPoolSize = 100000) {
  const docs = new Array(count);
  for (let i = 0; i < count; i++) {
    docs[i] = generateDocument(docSizeKB, userPoolSize);
  }
  return docs;
}
