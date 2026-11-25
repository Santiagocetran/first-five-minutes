// The first supported network path is one verbatim HTTPS download, before any
// project code has run. More general package managers need their own evidence.
export function documentedDownload(steps, hosts) {
  const command = steps[0]?.command;
  if (typeof command !== 'string' || steps[0].mode === 'service' || hosts.length !== 1) return null;
  const parsed = /^curl (?:-fsS )?-o ([A-Za-z0-9][A-Za-z0-9_.-]{0,127}) (https:\/\/[a-zA-Z0-9./_:%+-]+)$/.exec(command);
  if (!parsed) return null;
  const [, path, address] = parsed;
  const url = new URL(address);
  if (url.hostname !== hosts[0] || url.username || url.password || url.port || url.pathname === '/') return null;
  return { command, path, url: url.href };
}
