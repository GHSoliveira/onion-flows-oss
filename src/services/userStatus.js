const onlineUserIds = new Set();

export const markOnline = (userId) => {
  if (!userId) return;
  onlineUserIds.add(userId);
};

export const markOffline = (userId) => {
  if (!userId) return;
  onlineUserIds.delete(userId);
};

export const getOnlineUserIds = () => new Set(onlineUserIds);
