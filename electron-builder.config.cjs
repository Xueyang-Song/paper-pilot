const signingEnabled = process.env.AZURE_SIGNING_ENABLED === "1";

const requireEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} must be set when AZURE_SIGNING_ENABLED=1`);
  }

  return value;
};

const config = {
  appId: "science.paperpilot.app",
  productName: "Paper Pilot",
  npmRebuild: false,
  directories: {
    output: "release",
  },
  artifactName: "Paper-Pilot-Setup-${version}.${ext}",
  files: ["dist/**/*", "dist-electron/**/*", "package.json"],
  asarUnpack: ["**/*.node"],
  publish: [
    {
      provider: "github",
      owner: "Xueyang-Song",
      repo: "paper-pilot",
      channel: "latest",
      releaseType: "release",
    },
  ],
  win: {
    target: "nsis",
  },
  mac: {
    target: "dmg",
  },
  linux: {
    target: "AppImage",
  },
};

if (signingEnabled) {
  config.forceCodeSigning = true;
  config.win = {
    ...config.win,
    azureSignOptions: {
      publisherName: requireEnv("AZURE_SIGNING_PUBLISHER_NAME"),
      endpoint: requireEnv("AZURE_SIGNING_ENDPOINT"),
      certificateProfileName: requireEnv(
        "AZURE_SIGNING_CERTIFICATE_PROFILE_NAME",
      ),
      codeSigningAccountName: requireEnv("AZURE_SIGNING_ACCOUNT_NAME"),
      fileDigest: "SHA256",
      timestampRfc3161: "http://timestamp.acs.microsoft.com",
      timestampDigest: "SHA256",
    },
  };
}

module.exports = config;
