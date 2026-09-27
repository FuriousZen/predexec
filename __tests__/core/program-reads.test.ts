import { describe, expect, it } from "vitest";
import { inlineProgramReadPaths } from "../../core/index.ts";

describe("inlineProgramReadPaths (R27(c))", () => {
  it.each<[string, string[]]>([
    [`python3 -c "print(open('.env').read())"`, [".env"]],
    [`python3 -c "import io; print(io.open('a/b').read())"`, ["a/b"]],
    [`node -e "console.log(require('fs').readFileSync('.env','utf8'))"`, [".env"]],
    [`node -e "const fs=require('fs'); console.log(fs.readFileSync('x.txt','utf8'))"`, ["x.txt"]],
    [`node -e "console.log(require('./cfg.json').a)"`, ["./cfg.json"]],
    [`ruby -e 'puts File.read(".env")'`, [".env"]],
    [`perl -e 'open(my $f, "<", ".env"); print <$f>'`, [".env"]],
    [`perl -e 'open(F, "<.env"); print <F>'`, [".env"]],
    [`perl -e 'open F, "<", ".env"; print <F>'`, [".env"]],
    [`php -r 'echo file_get_contents(".env");'`, [".env"]],
    ["python3 - <<'EOF'\nprint(open('.env').read())\nEOF", [".env"]],
    [`python3 <<< "print(open('.env').read())"`, [".env"]],
    [`timeout 5 python3 -c "print(open('.env').read())"`, [".env"]],
    [`echo hi && python3 -c "print(1)"`, []],
    [`python3 -c "# open('.env')\nprint(1)"`, []],
    [`python3 -c "print('open(.env)')"`, []],
    ["cat .env", []],
    [`perl -ne 'print if /x/'`, []],
  ])("%s reads %j", (command, paths) => {
    expect(inlineProgramReadPaths(command)).toEqual({ paths, unresolved: null });
  });

  it.each([
    `python3 -c "import os; print(open(os.environ['F']).read())"`,
    `python3 -c "print(open(f'.{1}').read())"`,
    `node -e "const p='.env'; console.log(require('fs').readFileSync(p,'utf8'))"`,
    `perl -e 'open(F, $ARGV[0])'`,
    `ruby -e 'puts File.read ".env"'`,
    `perl -e 'local @ARGV=(".e"."nv"); print <>'`,
    `perl -e 'push @ARGV, ".env"; print <>'`,
    `perl -e '$ARGV[0] = ".env"; print <>'`,
    `perl -e '*ARGV = [".env"]; print <>'`,
    `perl -e 'print scalar(@ARGV)'`,
    `perl -e '@{"AR"."GV"}=(".env"); print <>'`,
    `perl -e '$_ = ".env" for @ARGV; print <>'`,
    // R31: no literal @ARGV list is trusted, and aliasing that never spells ARGV counts.
    `perl -e 'local @ARGV=(".env"); print <>'`,
    `perl -e '@ARGV = qw(a .env); print <<>>'`,
    `perl -e '*F = $::{"AR"."GV"}; @F = (".env"); print <>'`,
    `perl -e '*F = $main::{"AR"."GV"}; @F = (".env"); print <F>'`,
    `perl -e '(*F) = $::{"AR"."GV"}; @F = (".env"); print <>'`,
    `perl -e '*F = "AR"."GV"; @F = (".env"); print <>'`,
    `perl -e 'for my $k (keys %::) { 1 } print <>'`,
    `perl -ne 'BEGIN { local *F = "AR"."GV" } print'`,
  ])("%s is unresolvable", (command) => {
    expect(inlineProgramReadPaths(command).unresolved).not.toBeNull();
  });
});
