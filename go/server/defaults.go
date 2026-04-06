package server

import "os"

// DetectRealm checks environment variables for a suitable realm value.
// It iterates through common platform-specific variables before falling
// back to the default realm.
func DetectRealm() string {
	for _, key := range []string{
		"MPP_REALM", "FLY_APP_NAME", "HEROKU_APP_NAME",
		"RAILWAY_SERVICE_NAME", "RENDER_SERVICE_NAME",
		"K_SERVICE", "HOSTNAME",
	} {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	return defaultRealm
}

// DetectSecretKey reads the MPP_SECRET_KEY environment variable.
func DetectSecretKey() string {
	return os.Getenv(secretKeyEnvVar)
}
