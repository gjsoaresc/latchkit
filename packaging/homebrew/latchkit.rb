# Latchkit Homebrew formula — SCAFFOLD, not yet tapped or published.
#
# See packaging/homebrew/README.md for status. In short: macOS and Linux
# release artifacts are deferred experimental work (docs/releases.md), so
# there is no published `latchkit-<version>-<target>.tar.gz` this formula
# could point at with a real checksum yet. The mechanism below is real and
# mirrors install.sh exactly, but the placeholders must be replaced from an
# actual qualified release before this formula is added to any tap, and it
# has not been exercised by `brew install --build-from-source` or any CI.
#
# frozen_string_literal: true

class Latchkit < Formula
  desc "Your agents. One workflow. Local CLI and browser console for coding-agent skills"
  homepage "https://github.com/willahealm/latchkit"
  license "MIT"

  # REPLACE with the exact tagged release version before tapping this formula.
  version "0.0.0"

  on_macos do
    on_arm do
      url "https://github.com/willahealm/latchkit/releases/download/v#{version}/latchkit-#{version}-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # REPLACE
    end
    on_intel do
      url "https://github.com/willahealm/latchkit/releases/download/v#{version}/latchkit-#{version}-darwin-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # REPLACE
    end
  end

  on_linux do
    url "https://github.com/willahealm/latchkit/releases/download/v#{version}/latchkit-#{version}-linux-x64.tar.gz"
    sha256 "0000000000000000000000000000000000000000000000000000000000000000" # REPLACE
  end

  def latchkit_target
    if OS.mac? && Hardware::CPU.arm?
      "darwin-arm64"
    elsif OS.mac?
      "darwin-x64"
    else
      "linux-x64"
    end
  end

  def install
    # Drive Latchkit's own standalone installation manager — the identical
    # code path install.sh calls into (src/installation/manager.ts) — so a
    # Homebrew-managed install is staged, per-file checksum-verified against
    # the embedded bundle manifest, and smoke-checked before activation,
    # exactly like a direct install.sh run. Homebrew's own `sha256` above
    # already verified the whole downloaded archive; this adds the same
    # per-file manifest verification a direct install gets, as defense in
    # depth, not a replacement for it.
    node = buildpath/"runtime/node"
    entry = buildpath/"app/dist/src/installation/entry.js"
    system node, entry, "install", "--root", prefix, "--bundle", buildpath, "--target",
           latchkit_target
    bin.install_symlink prefix/"bin/latchkit" => "latchkit"
  end

  def caveats
    <<~EOS
      Latchkit's own versioned root lives under:
        #{prefix}

      `brew upgrade`/`brew uninstall` operate only on this Homebrew-managed
      root. They never touch a separate direct install.sh installation's
      root, and never touch any project's .latchkit/ state — that state
      lives inside each project directory, not under this prefix.

      `brew uninstall` removes the symlinked launcher; Latchkit's own
      manager conservatively retains staged version directories under this
      prefix (see docs/installation.md#uninstall-and-retained-versions).
      Removing the whole Homebrew Cellar entry for latchkit (the normal
      `brew uninstall` behavior) also removes those retained directories,
      which direct install.sh uninstall does not do.
    EOS
  end

  test do
    system "#{bin}/latchkit", "--version"
  end
end
