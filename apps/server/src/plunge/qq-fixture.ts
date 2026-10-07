export const wire = (extra: Record<string, unknown> = {}) => ({
  post_type: "message",
  self_id: 42,
  user_id: 7,
  message_type: "group",
  group_id: 99,
  time: 1791373200,
  message_id: -12,
  message_seq: 3,
  sender: { user_id: 7, nickname: "observed nickname", card: "observed card" },
  message: [{ type: "text", data: { text: "hello" } }],
  ...extra
});
