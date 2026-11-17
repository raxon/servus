export const composeProviderArguments = [
  '--providers.docker.endpoint=unix:///var/run/docker.sock',
  '--providers.docker.exposedbydefault=false',
  '--providers.docker.network=panel-ingress',
  '--providers.docker.constraints=Label(`panel.compose`,`true`)',
];

/** Only explicitly owned Compose containers enter the Docker provider. */
export function withComposeProvider(arguments_:readonly string[]):string[] {
  for(const expected of composeProviderArguments) {
    const key=expected.split('=',1)[0]!;
    if(arguments_.some(argument=>argument.startsWith(`${key}=`)&&argument!==expected))throw new Error('The owned ingress has a conflicting Docker provider setting. Review its configuration before enabling Compose routing.');
  }
  return [...arguments_,...composeProviderArguments.filter(argument=>!arguments_.includes(argument))];
}
