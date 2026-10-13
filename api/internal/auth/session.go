package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

const audSession = "session"

type SessionCodec struct{ Secret []byte }

type VerifiedSession struct {
	UserID       string
	TokenHash    string
	ExpiresAt    int64
	SigningKeyID string
}

func (s SessionCodec) SigningKeyID() string { return HashToken(string(s.Secret)) }
func (s SessionCodec) VerifySessionDetails(v string) (VerifiedSession, bool) {
	p, ok := s.verifyPayload(v, audSession)
	if !ok {
		return VerifiedSession{}, false
	}
	return VerifiedSession{UserID: p.Subject, TokenHash: HashToken(v), ExpiresAt: p.ExpiresAt, SigningKeyID: s.SigningKeyID()}, true
}

type signedPayload struct {
	Subject   string `json:"sub"`
	Audience  string `json:"aud"`
	ExpiresAt int64  `json:"exp"`
}

func (s SessionCodec) Sign(userID string) string {
	return s.SignForAudience(userID, audSession, 30*24*time.Hour)
}

func (s SessionCodec) SignForAudience(userID, audience string, ttl time.Duration) string {
	p := signedPayload{Subject: userID, Audience: audience, ExpiresAt: time.Now().Add(ttl).Unix()}
	payload, _ := json.Marshal(p)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.Secret)
	mac.Write([]byte(payloadB64))
	sig := mac.Sum(nil)
	return "v1." + payloadB64 + "." + base64.RawURLEncoding.EncodeToString(sig)
}
func (s SessionCodec) VerifySession(v string) (string, bool) {
	return s.VerifyAudience(v, audSession)
}

func (s SessionCodec) VerifyAudience(v, audience string) (string, bool) {
	p, ok := s.verifyPayload(v, audience)
	return p.Subject, ok
}
func (s SessionCodec) verifyPayload(v, audience string) (signedPayload, bool) {
	parts := strings.Split(v, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return signedPayload{}, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return signedPayload{}, false
	}
	mac := hmac.New(sha256.New, s.Secret)
	mac.Write([]byte(parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return signedPayload{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return signedPayload{}, false
	}
	var p signedPayload
	if err := json.Unmarshal(payload, &p); err != nil || p.Subject == "" || p.Audience != audience || p.ExpiresAt <= time.Now().Unix() {
		return signedPayload{}, false
	}
	return p, true
}
