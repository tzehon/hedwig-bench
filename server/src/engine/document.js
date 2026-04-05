import { randomBytes, randomInt, randomUUID } from 'node:crypto';

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
  return randomBytes(bytes).toString('hex');
}

function randomUserId(userPoolSize) {
  const num = randomInt(1, userPoolSize + 1);
  return `user_${String(num).padStart(6, '0')}`;
}

function randomSubject() {
  return SUBJECT_LINES[randomInt(0, SUBJECT_LINES.length)];
}

function randomStatus() {
  return STATUSES[randomInt(0, STATUSES.length)];
}

function generateBodyText(targetBytes) {
  // Build random body text by stringing together words until we reach target size
  const chunks = [];
  let currentSize = 0;

  while (currentSize < targetBytes) {
    const word = BODY_WORDS[randomInt(0, BODY_WORDS.length)];
    chunks.push(word);
    currentSize += word.length + 1; // +1 for space
  }

  let body = chunks.join(' ');

  // Trim or pad to exact size
  if (body.length > targetBytes) {
    body = body.slice(0, targetBytes);
  } else {
    // Pad with spaces if slightly under
    body = body.padEnd(targetBytes, ' ');
  }

  return body;
}

/**
 * Generate a single inbox message document.
 * @param {number} docSizeKB - Target document size in KB
 * @param {number} userPoolSize - Size of the user ID pool (1 to userPoolSize)
 * @returns {object} A document matching the inbox message schema
 */
export function generateDocument(docSizeKB = 1, userPoolSize = 100000) {
  const targetBytes = docSizeKB * 1024;

  // Build the document skeleton first (without body) to estimate overhead
  const doc = {
    user_id: randomUserId(userPoolSize),
    msg_id: randomUUID(),
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

  // Estimate the BSON overhead of all fields except body.
  const skeletonSize = JSON.stringify(doc).length;

  // The body needs to fill the remaining space
  const bodyTargetBytes = Math.max(0, targetBytes - skeletonSize);
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
