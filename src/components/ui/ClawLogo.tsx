/**
 * ClawAscii — ASCII art lobster claw for login/branding screens.
 * Uses block drawing characters matching the terminal aesthetic.
 */
export function ClawAscii({ className }: { className?: string }) {
  return (
    <pre className={`text-accent font-mono text-sm leading-tight select-none ${className || ''}`}>
{`▐▌    ▐▌
▐█    █▌
▐██▄▄██▌
 ▀████▀
   ██`}
    </pre>
  );
}
