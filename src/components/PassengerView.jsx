import React, { useState, useCallback, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet';
import MapFitBounds from './MapFitBounds';
import ActiveTripCard from './ActiveTripCard';
import CompletedTripCard from './CompletedTripCard';
import { BottomSheet, OverlayPanel, Toast, EmptyState } from './layout';
import L from 'leaflet';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { ClutchHubSdk, verifyUnsignedTransaction } from 'clutch-hub-sdk-js';
import { API_URL, CHAIN_ID, MAP_ATTRIBUTION, getMapTileUrl } from '../config';
import { useClutchSdk } from '../hooks/useClutchSdk';
import { useTheme } from '../hooks/useTheme';
import { truncAddr } from '../utils/address';
import { formatUsd, parseUsdToClt } from '../utils/money';
import {
  subscribeActiveTripsCompat,
  subscribeRecentTripsCompat,
  subscribeRideOffersCompat,
  subscribeRideRequestsCompat,
} from '../sdkRealtime';
import TransactionHistory from './TransactionHistory';
import { usePrivateKeyRequest } from './layout/usePrivateKeyRequest.jsx';
import { pickupIcon, dropoffIcon, currentLocationIcon } from '../utils/mapMarkers';
import MapLegend from './MapLegend';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });

/** Map open ride requests to card rows for the signed-in passenger (shared by subscription + manual refresh). */
function formatPassengerOpenRequests(allRequests, publicKey) {
  if (!publicKey) return [];
  const myRequests = allRequests.filter((r) => r.passengerAddress === publicKey);
  const stored = localStorage.getItem(`clutch_tx_${publicKey}`);
  let txMap = {};
  if (stored) {
    try {
      JSON.parse(stored).forEach((tx) => {
        if (tx.txHash) txMap[tx.txHash] = tx;
      });
    } catch {
      /* ignore */
    }
  }
  const formatted = myRequests.map((r) => {
    const pickupLat = Number(r.pickupLocation?.latitude);
    const pickupLng = Number(r.pickupLocation?.longitude);
    const dropoffLat = Number(r.dropoffLocation?.latitude);
    const dropoffLng = Number(r.dropoffLocation?.longitude);
    const localTx = txMap[r.txHash];
    return {
      type: 'Ride Request',
      timestamp: localTx?.timestamp ?? Date.now(),
      pickup: { lat: pickupLat, lng: pickupLng },
      dropoff: { lat: dropoffLat, lng: dropoffLng },
      fare: r.fare,
      txHash: r.txHash,
      passengerAddress: r.passengerAddress,
    };
  });
  return formatted
    .filter((r) => Number.isFinite(r.pickup.lat) && Number.isFinite(r.pickup.lng) && Number.isFinite(r.dropoff.lat) && Number.isFinite(r.dropoff.lng))
    .sort((a, b) => b.timestamp - a.timestamp);
}

const LocationSelector = ({ pickup, dropoff, setPickup, setDropoff }) => {
  useMapEvents({
    click(e) {
      if (!pickup) setPickup(e.latlng);
      else if (!dropoff) setDropoff(e.latlng);
    },
  });
  return null;
};

const MapCenterTracker = ({ onCenterChange }) => {
  const map = useMap();
  useEffect(() => {
    const c = map.getCenter();
    onCenterChange?.({ lat: Number(c.lat), lng: Number(c.lng) });
  }, [map, onCenterChange]);
  useMapEvents({
    moveend(e) {
      const c = e.target.getCenter();
      onCenterChange?.({ lat: Number(c.lat), lng: Number(c.lng) });
    },
  });
  return null;
};

const MapFlyToLocation = ({ location }) => {
  const map = useMap();

  useEffect(() => {
    if (!location) return;
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const container = map.getContainer?.();
    const isVisible = !!container && container.offsetWidth > 0 && container.offsetHeight > 0;
    if (!isVisible) return;
    const zoom = Number(map.getZoom());
    const safeZoom = Number.isFinite(zoom) ? Math.max(zoom, 14) : 14;
    try {
      map.flyTo([lat, lng], safeZoom, { duration: 0.7 });
    } catch (err) {
      // Hidden/inactive maps can still throw inside Leaflet animations; ignore safely.
      console.warn('Skipped map flyTo due to invalid map state:', err);
    }
  }, [location, map]);

  return null;
};

const RideRequestCard = ({
  req,
  userProfile,
  hubSdk,
  onAcceptSuccess,
  onCancelSuccess,
  requestPrivateKey,
}) => {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [acceptingOfferTxHash, setAcceptingOfferTxHash] = useState(null);
  const [acceptError, setAcceptError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  const fetchOffers = useCallback(async () => {
    if (!userProfile.publicKey || !req.txHash) return;
    setLoading(true);
    setError(null);
    try {
      const sdk = hubSdk ?? new ClutchHubSdk(API_URL, userProfile.publicKey, undefined, CHAIN_ID);
      const fetchedOffers = await sdk.listRideOffers(req.txHash);
      setOffers(fetchedOffers);
    } catch (err) {
      console.error('Failed to fetch offers:', err);
      setError(err.message || 'Failed to load offers');
    } finally {
      setLoading(false);
    }
  }, [req.txHash, userProfile.publicKey, hubSdk]);

  useEffect(() => {
    if (!userProfile.publicKey || !req.txHash) return undefined;
    setLoading(true);
    setError(null);
    const sdk = hubSdk ?? new ClutchHubSdk(API_URL, userProfile.publicKey, undefined, CHAIN_ID);
    const dispose = subscribeRideOffersCompat(sdk, req.txHash, {
      onData: (list) => {
        setOffers(list);
        setLoading(false);
      },
      onError: (err) => {
        console.error('Offers subscription error:', err);
        setError(err.message || 'Failed to load offers');
        setLoading(false);
      },
    });
    return () => dispose();
  }, [req.txHash, userProfile.publicKey, hubSdk]);

  const handleAcceptOffer = useCallback(async (offer) => {
    if (!userProfile.publicKey || !offer.txHash) return;
    setAcceptingOfferTxHash(offer.txHash);
    setAcceptError(null);
    try {
      // Private key needed before createUnsigned*: generateToken requires a signed challenge.
      let privateKey = userProfile.privateKey;
      if (!privateKey) {
        privateKey = await requestPrivateKey('Enter your private key to sign the acceptance:');
        if (!privateKey) {
          setAcceptError('Signing cancelled.');
          setAcceptingOfferTxHash(null);
          return;
        }
      }
      const sdk = hubSdk ?? new ClutchHubSdk(API_URL, userProfile.publicKey, privateKey, CHAIN_ID);
      sdk.setPrivateKey(privateKey);
      const unsignedTx = await sdk.createUnsignedRideAcceptance({ rideOfferTxHash: offer.txHash });
      const signature = await sdk.signTransaction(unsignedTx, privateKey, {
        type: 'RideAcceptance',
        refTxHash: offer.txHash,
      });
      await sdk.submitTransaction(signature.rawTransaction);
      TransactionHistory.addTransaction(userProfile.publicKey, {
        type: 'Ride Acceptance',
        timestamp: Date.now(),
        rideOfferTxHash: offer.txHash,
        status: 'success',
        txHash: signature.txHash || '',
      });
      onAcceptSuccess?.();
    } catch (err) {
      console.error('Accept offer failed:', err);
      setAcceptError(err.message || 'Failed to accept offer');
      TransactionHistory.addTransaction(userProfile.publicKey, {
        type: 'Ride Acceptance',
        timestamp: Date.now(),
        rideOfferTxHash: offer.txHash,
        status: 'failed',
        error: err.message,
      });
    } finally {
      setAcceptingOfferTxHash(null);
    }
  }, [userProfile, onAcceptSuccess, requestPrivateKey, hubSdk]);

  const handleCancelRequest = useCallback(async () => {
    if (!userProfile.publicKey || !req.txHash) return;
    setCancelling(true);
    setCancelError(null);
    try {
      // Private key needed before createUnsigned*: generateToken requires a signed challenge.
      let privateKey = userProfile.privateKey;
      if (!privateKey) {
        privateKey = await requestPrivateKey('Enter your private key to sign the cancellation:');
        if (!privateKey) {
          setCancelError('Signing cancelled.');
          setCancelling(false);
          return;
        }
      }
      const sdk = hubSdk ?? new ClutchHubSdk(API_URL, userProfile.publicKey, privateKey, CHAIN_ID);
      sdk.setPrivateKey(privateKey);
      const unsignedTx = await sdk.createUnsignedRideRequestCancel({ rideRequestTxHash: req.txHash });
      const signature = await sdk.signTransaction(unsignedTx, privateKey, {
        type: 'RideRequestCancel',
        refTxHash: req.txHash,
      });
      await sdk.submitTransaction(signature.rawTransaction);
      TransactionHistory.addTransaction(userProfile.publicKey, {
        type: 'Ride Request Cancel',
        timestamp: Date.now(),
        rideRequestTxHash: req.txHash,
        status: 'success',
        txHash: signature.txHash || '',
      });
      onCancelSuccess?.();
    } catch (err) {
      console.error('Cancel request failed:', err);
      setCancelError(err.message || 'Failed to cancel request');
      TransactionHistory.addTransaction(userProfile.publicKey, {
        type: 'Ride Request Cancel',
        timestamp: Date.now(),
        rideRequestTxHash: req.txHash,
        status: 'failed',
        error: err.message,
      });
    } finally {
      setCancelling(false);
    }
  }, [userProfile, req.txHash, onCancelSuccess, requestPrivateKey, hubSdk]);

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="form-row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(req.timestamp).toLocaleString()}</span>
        <span className="fare-badge" title={`${req.fare} CLT`}>{formatUsd(req.fare)}</span>
      </div>

      <div>
        <div className="form-row" style={{ justifyContent: 'space-between', marginBottom: '0.625rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Offers ({offers.length})</span>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button type="button" className="btn-ghost" onClick={fetchOffers} disabled={loading} style={{ fontSize: '0.75rem' }}>
              {loading ? '...' : 'Refresh'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              style={{ fontSize: '0.75rem' }}
              onClick={handleCancelRequest}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling...' : 'Cancel request'}
            </button>
          </div>
        </div>

        {error && <div className="status-banner error" style={{ padding: '0.5rem', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{error}</div>}
        {cancelError && <div className="status-banner error" style={{ padding: '0.5rem', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{cancelError}</div>}
        {acceptError && <div className="status-banner error" style={{ padding: '0.5rem', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{acceptError}</div>}

        {offers.length === 0 && !loading && !error && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>No offers yet.</p>
        )}

        {/*
          Readiness item H1. Accepting is the moment the whole fare leaves the passenger and is
          held for the trip, and it is the moment the passenger gives up the recourse a card
          network would have provided. Neither of those was stated anywhere.
          Shown with the offers rather than in a modal: for play money, a dialog demanding
          acknowledgement of "you have no recourse" is theatre, and it trains people to click
          through exactly the dialog that would matter on a real deployment. A real deployment
          needs acknowledgement rather than display — see the readiness doc.
        */}
        {offers.length > 0 && (
          <div
            className="status-banner info"
            role="note"
            style={{ padding: '0.5rem 0.6rem', fontSize: '0.75rem', marginBottom: '0.5rem', textAlign: 'left', lineHeight: 1.5 }}
          >
            Accepting holds the full fare on chain straight away. You sign the payment yourself, so
            there is no card issuer to reverse it and <strong>no arbitration if you and the driver
            disagree</strong> — dispute resolution is not built yet. Either side can cancel before
            the fare is fully paid, and the unpaid part returns to you.
          </div>
        )}

        {offers.map((offer) => (
          <div key={offer.txHash} className="offer-row offer-row--driver">
            <div className="offer-row-driver">
              <div className="offer-avatar" aria-hidden>🚗</div>
              <div className="offer-row-driver-meta">
                <p className="offer-row-driver-address">{truncAddr(offer.driverAddress)}</p>
                <p className="offer-row-driver-label">Driver</p>
              </div>
            </div>
            <div className="offer-row-actions">
              <div className="offer-row-price" title={`${offer.fare} CLT`}>{formatUsd(offer.fare)}</div>
              <button
                type="button"
                className="btn-primary"
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', flexShrink: 0, marginTop: '0.35rem' }}
                onClick={() => handleAcceptOffer(offer)}
                disabled={!!acceptingOfferTxHash}
              >
                {acceptingOfferTxHash === offer.txHash ? 'Accepting...' : 'Accept'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PassengerView = ({ userProfile, externalTab, onTabSync }) => {
  const [fare, setFare] = useState('');
  const fareInputRef = useRef(null);
  const [pickup, setPickup] = useState(null);
  const [dropoff, setDropoff] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const submittingRef = useRef(false);
  const [transactionStatus, setTransactionStatus] = useState(null);
  const [requestReferrer, setRequestReferrer] = useState(null);
  const [, setRefreshBalanceCounter] = useState(0);
  const [previousRequests, setPreviousRequests] = useState([]);
  const [activeTrips, setActiveTrips] = useState([]);
  const [, setActiveTripsLoading] = useState(false);
  const [activeTripsError, setActiveTripsError] = useState(null);
  const [recentTrips, setRecentTrips] = useState([]);
  const [recentTripsLoading, setRecentTripsLoading] = useState(false);
  const [recentTripsError, setRecentTripsError] = useState(null);
  const [passengerTab, setPassengerTab] = useState('rides');
  const [myRideRefreshing, setMyRideRefreshing] = useState(false);
  const [myRideRefreshError, setMyRideRefreshError] = useState(null);
  const [myTripsRefreshing, setMyTripsRefreshing] = useState(false);
  const [myTripsRefreshError, setMyTripsRefreshError] = useState(null);
  const defaultMapCenter = [27.1883, 56.3772];
  const [currentLocation, setCurrentLocation] = useState(null);
  const [mapCenter, setMapCenter] = useState({ lat: defaultMapCenter[0], lng: defaultMapCenter[1] });
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const [sheetSnap, setSheetSnap] = useState('peek');

  const { PrivateKeyModal, requestPrivateKey } = usePrivateKeyRequest();

  const hubSdk = useClutchSdk(userProfile.publicKey, '0x0', userProfile.privateKey);

  const theme = useTheme();
  const tileUrl = getMapTileUrl(theme);

  const hasConcurrent = activeTrips.length > 0 || previousRequests.length > 0;
  const hasActiveTrip = activeTrips.length > 0;
  const isRouteSelected = !!pickup && !!dropoff;
  const phase = hasActiveTrip ? 'trip' : hasConcurrent ? 'waiting' : 'building';
  const mapActiveTrips = activeTrips.filter((t) => (
    Number.isFinite(Number(t?.pickupLocation?.latitude))
    && Number.isFinite(Number(t?.pickupLocation?.longitude))
    && Number.isFinite(Number(t?.dropoffLocation?.latitude))
    && Number.isFinite(Number(t?.dropoffLocation?.longitude))
  ));
  const firstActiveTrip = mapActiveTrips.length > 0 ? mapActiveTrips[0] : null;
  const activeTripPickup = firstActiveTrip
    ? [firstActiveTrip.pickupLocation.latitude, firstActiveTrip.pickupLocation.longitude]
    : null;
  const activeTripDropoff = firstActiveTrip
    ? [firstActiveTrip.dropoffLocation.latitude, firstActiveTrip.dropoffLocation.longitude]
    : null;

  useEffect(() => {
    if (externalTab) {
      setPassengerTab(externalTab);
    }
  }, [externalTab]);

  useEffect(() => {
    if (!userProfile.publicKey) {
      setActiveTrips([]);
      setActiveTripsLoading(false);
      return undefined;
    }
    setActiveTripsLoading(true);
    setActiveTripsError(null);
    const dispose = subscribeActiveTripsCompat(
      hubSdk,
      { passengerAddress: userProfile.publicKey },
      {
        onData: (trips) => {
          setActiveTrips(trips);
          setActiveTripsLoading(false);
        },
        onError: (err) => {
          console.error('Active trips subscription error:', err);
          setActiveTripsError(err.message || 'Failed to load active trips');
          setActiveTrips([]);
          setActiveTripsLoading(false);
        },
      }
    );
    return () => dispose();
  }, [userProfile.publicKey, hubSdk]);

  useEffect(() => {
    if (!userProfile.publicKey) {
      setRecentTrips([]);
      setRecentTripsLoading(false);
      return undefined;
    }
    setRecentTripsLoading(true);
    setRecentTripsError(null);
    const dispose = subscribeRecentTripsCompat(
      hubSdk,
      { passengerAddress: userProfile.publicKey },
      {
        onData: (trips) => {
          setRecentTrips(trips);
          setRecentTripsLoading(false);
        },
        onError: (err) => {
          console.error('Recent trips subscription error:', err);
          setRecentTripsError(err.message || 'Failed to load recent trips');
          setRecentTrips([]);
          setRecentTripsLoading(false);
        },
      }
    );
    return () => dispose();
  }, [userProfile.publicKey, hubSdk]);

  useEffect(() => {
    if (!userProfile.publicKey) {
      setPreviousRequests([]);
      return undefined;
    }
    const dispose = subscribeRideRequestsCompat(hubSdk, null, {
      onData: (allRequests) => {
        setPreviousRequests(formatPassengerOpenRequests(allRequests, userProfile.publicKey));
      },
      onError: (err) => {
        console.error('Ride requests subscription error:', err);
      },
    });
    return () => dispose();
  }, [userProfile.publicKey, hubSdk]);

  const handleReset = useCallback(() => {
    setPickup(null);
    setDropoff(null);
    setFare('');
    setTransactionStatus(null);
    setRequestReferrer(null);
  }, []);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }
    if (!pickup || !dropoff || !userProfile.publicKey) return;
    if (submittingRef.current) return;
    let fareClt;
    try {
      fareClt = parseUsdToClt(fare);
    } catch {
      setTransactionStatus({ type: 'error', message: 'Enter a valid fare amount.' });
      return;
    }
    submittingRef.current = true;
    setIsLoading(true);
    setRequestReferrer(null);
    try {
      // The private key is needed up front: creating the unsigned tx authenticates via
      // generateToken, which requires a signed proof-of-key-ownership challenge.
      let privateKey = userProfile.privateKey;
      if (!privateKey) {
        privateKey = await requestPrivateKey('Enter your private key to sign the transaction:');
        if (!privateKey) {
          setTransactionStatus({ type: 'warning', message: 'Signing cancelled.' });
          submittingRef.current = false;
          setIsLoading(false);
          return;
        }
      }
      hubSdk.setPrivateKey(privateKey);
      setTransactionStatus({ type: 'info', message: 'Creating transaction...' });
      const unsignedTx = await hubSdk.createUnsignedRideRequest({ pickup, dropoff, fare: fareClt });
      const expected = { type: 'RideRequest', fare: fareClt };
      setRequestReferrer(verifyUnsignedTransaction(unsignedTx, expected).referrer);
      setTransactionStatus({ type: 'info', message: 'Signing...' });
      const signature = await hubSdk.signTransaction(unsignedTx, privateKey, expected);
      setTransactionStatus({ type: 'info', message: 'Submitting...' });
      await hubSdk.submitTransaction(signature.rawTransaction);
      TransactionHistory.addTransaction(userProfile.publicKey, {
        type: 'Ride Request',
        timestamp: Date.now(),
        pickup, dropoff,
        fare: fareClt.toString(),
        status: 'success',
        txHash: signature.txHash || '',
      });
      setTransactionStatus({ type: 'success', message: 'Ride request submitted! Awaiting driver offers.' });
      setRefreshBalanceCounter((prev) => prev + 1);
      setTimeout(() => setTransactionStatus(null), 5000);
    } catch (err) {
      console.error(err);
      TransactionHistory.addTransaction(userProfile.publicKey, {
        type: 'Ride Request',
        timestamp: Date.now(),
        pickup, dropoff,
        fare: fareClt.toString(),
        status: 'failed',
        error: err.message,
      });
      setTransactionStatus({ type: 'error', message: 'Failed: ' + (err.message || 'Unknown error') });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  }, [pickup, dropoff, userProfile, fare, hubSdk]);

  const refreshMyRide = useCallback(async () => {
    if (!userProfile.publicKey) return;
    setMyRideRefreshing(true);
    setMyRideRefreshError(null);
    try {
      const [allRequests, trips] = await Promise.all([
        hubSdk.listRideRequests(),
        hubSdk.listActiveTrips({ passengerAddress: userProfile.publicKey }),
      ]);
      setPreviousRequests(formatPassengerOpenRequests(allRequests, userProfile.publicKey));
      setActiveTrips(trips);
      setActiveTripsError(null);
      setActiveTripsLoading(false);
    } catch (err) {
      console.error('Refresh my ride failed:', err);
      setMyRideRefreshError(err.message || 'Failed to refresh');
    } finally {
      setMyRideRefreshing(false);
    }
  }, [userProfile.publicKey, hubSdk]);

  const refreshPassengerMyTrips = useCallback(async () => {
    if (!userProfile.publicKey) return;
    setMyTripsRefreshing(true);
    setMyTripsRefreshError(null);
    try {
      const trips = await hubSdk.listActiveTrips({ passengerAddress: userProfile.publicKey });
      setActiveTrips(trips);
      setActiveTripsError(null);
      setActiveTripsLoading(false);
    } catch (err) {
      console.error('Refresh my trips failed:', err);
      setMyTripsRefreshError(err.message || 'Failed to refresh trips');
    } finally {
      setMyTripsRefreshing(false);
    }
  }, [userProfile.publicKey, hubSdk]);

  const handleUseCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported in this browser.');
      return;
    }

    setLocating(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        setCurrentLocation(next);
        setMapCenter(next);
        if (!hasActiveTrip && !hasConcurrent && !pickup) {
          setPickup(next);
        }
        setLocating(false);
      },
      (err) => {
        setLocationError(err?.message || 'Unable to get your current location.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, [hasActiveTrip, hasConcurrent, pickup]);

  const handleSetFromCenter = useCallback(() => {
    if (hasConcurrent || hasActiveTrip) return;
    if (!pickup) {
      setPickup(mapCenter);
      return;
    }
    if (!dropoff) {
      setDropoff(mapCenter);
    }
  }, [hasConcurrent, hasActiveTrip, pickup, dropoff, mapCenter]);

  // Once route points are set, move user directly to fare entry.
  useEffect(() => {
    if (!isRouteSelected || hasConcurrent || hasActiveTrip) return;
    fareInputRef.current?.focus();
  }, [isRouteSelected, hasConcurrent, hasActiveTrip]);

  // Sheet position follows the flow: building stays low (map interaction),
  // fare entry and waiting/trip lift the sheet so content is visible.
  useEffect(() => {
    if (phase === 'building') setSheetSnap(isRouteSelected ? 'half' : 'peek');
    else setSheetSnap('half');
  }, [phase, isRouteSelected]);

  // Try to center the map at the user's location on first render.
  useEffect(() => {
    if (!navigator.geolocation || currentLocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCurrentLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => {
        // Keep fallback center silently if geolocation fails/denied.
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }, [currentLocation]);

  const stepIndex = !pickup ? 0 : !dropoff ? 1 : !fare ? 2 : 3;
  const stepLabel = ['Set pickup', 'Set destination', 'Enter fare', 'Confirm request'][stepIndex];

  const sheetHeader =
    phase === 'trip' ? (
      <div className="sheet-header-row">
        <div>
          <h2 className="sheet-title">Trip in progress</h2>
          <p className="sheet-subtitle">Pay as you go; the trip completes when fully paid.</p>
        </div>
        <button type="button" className="btn-ghost" onClick={refreshPassengerMyTrips} disabled={myTripsRefreshing}>
          {myTripsRefreshing ? '…' : 'Refresh'}
        </button>
      </div>
    ) : phase === 'waiting' ? (
      <div className="sheet-header-row">
        <div>
          <h2 className="sheet-title">Waiting for offers</h2>
          <p className="sheet-subtitle">Your request is live. Offers appear below.</p>
        </div>
        <button type="button" className="btn-ghost" onClick={refreshMyRide} disabled={myRideRefreshing}>
          {myRideRefreshing ? '…' : 'Refresh'}
        </button>
      </div>
    ) : (
      <div>
        <div className="sheet-header-row">
          <div>
            <h2 className="sheet-title">Where to?</h2>
            <p className="sheet-subtitle">Step {stepIndex + 1} of 4 — {stepLabel}</p>
          </div>
          {(!pickup || !dropoff) && (
            <button type="button" className="btn-primary" onClick={handleSetFromCenter}>
              {!pickup ? 'Set pickup' : 'Set drop-off'}
            </button>
          )}
        </div>
        <div className="sheet-step-pills" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`sheet-step-pill ${i <= stepIndex ? 'sheet-step-pill--done' : ''}`} />
          ))}
        </div>
      </div>
    );

  return (
    <div className="mapfirst-view">
      <div className="mapfirst-map">
        {!userProfile.publicKey ? null : (
          <MapContainer
            center={currentLocation ? [currentLocation.lat, currentLocation.lng] : defaultMapCenter}
            zoom={12}
            zoomControl={false}
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer key={tileUrl} url={tileUrl} attribution={MAP_ATTRIBUTION} />
            <MapCenterTracker onCenterChange={setMapCenter} />

            {previousRequests.map((r) => (
              !hasActiveTrip && (
                <React.Fragment key={r.txHash}>
                  <Marker position={[r.pickup.lat, r.pickup.lng]} icon={pickupIcon}><Popup>Pickup (awaiting offers)</Popup></Marker>
                  <Marker position={[r.dropoff.lat, r.dropoff.lng]} icon={dropoffIcon}><Popup>Dropoff (awaiting offers)</Popup></Marker>
                  <Polyline positions={[[r.pickup.lat, r.pickup.lng], [r.dropoff.lat, r.dropoff.lng]]} color="#94a3b8" weight={3} opacity={0.75} />
                </React.Fragment>
              )
            ))}

            {mapActiveTrips.map((t) => (
              <React.Fragment key={t.txHash}>
                <Marker position={[Number(t.pickupLocation.latitude), Number(t.pickupLocation.longitude)]} icon={pickupIcon}><Popup>Pickup (active trip)</Popup></Marker>
                <Marker position={[Number(t.dropoffLocation.latitude), Number(t.dropoffLocation.longitude)]} icon={dropoffIcon}><Popup>Dropoff (active trip)</Popup></Marker>
                <Polyline positions={[[Number(t.pickupLocation.latitude), Number(t.pickupLocation.longitude)], [Number(t.dropoffLocation.latitude), Number(t.dropoffLocation.longitude)]]} color="var(--accent)" weight={4} opacity={0.9} />
              </React.Fragment>
            ))}

            {hasActiveTrip && activeTripPickup && activeTripDropoff && (
              <MapFitBounds positions={[activeTripPickup, activeTripDropoff]} />
            )}
            {!hasActiveTrip && pickup && dropoff && (
              <MapFitBounds positions={[[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]]} />
            )}
            {currentLocation && <MapFlyToLocation location={currentLocation} />}
            <LocationSelector
              pickup={pickup}
              dropoff={dropoff}
              setPickup={hasConcurrent || isRouteSelected ? () => {} : setPickup}
              setDropoff={hasConcurrent || isRouteSelected ? () => {} : setDropoff}
            />
            {currentLocation && <Marker position={currentLocation} icon={currentLocationIcon}><Popup>Your current location</Popup></Marker>}
            {!hasActiveTrip && pickup && <Marker position={pickup} icon={pickupIcon}><Popup>Pickup</Popup></Marker>}
            {!hasActiveTrip && dropoff && <Marker position={dropoff} icon={dropoffIcon}><Popup>Dropoff</Popup></Marker>}
            {!hasActiveTrip && pickup && dropoff && (
              <Polyline
                positions={[[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]]}
                color="var(--accent)"
                weight={3}
                opacity={0.8}
              />
            )}
          </MapContainer>
        )}
        <MapLegend style={{ position: 'absolute', top: 'calc(4rem + env(safe-area-inset-top))', left: '0.75rem', zIndex: 900 }} />
        {phase === 'building' && !isRouteSelected && userProfile.publicKey && (
          <div className="map-center-pin" aria-hidden>
            <div className="map-center-pin-head">+</div>
            <div className="map-center-pin-stem" />
          </div>
        )}
      </div>

      <div className="map-fabs">
        <button type="button" className="map-fab" onClick={handleUseCurrentLocation} disabled={locating}>
          {locating ? 'Locating…' : '📍 My location'}
        </button>
        {phase === 'building' && (pickup || dropoff) && (
          <button type="button" className="map-fab" onClick={handleReset} disabled={isLoading}>
            ↺ Reset
          </button>
        )}
      </div>

      <Toast status={transactionStatus} onDismiss={() => setTransactionStatus(null)} />

      <BottomSheet snap={sheetSnap} onSnapChange={setSheetSnap} header={sheetHeader} ariaLabel="Passenger ride panel">
        {!userProfile.publicKey ? (
          <EmptyState message="Connect your wallet to request a ride." />
        ) : (
          <>
            {activeTripsError && <div className="status-banner error">{activeTripsError}</div>}
            {myRideRefreshError && <div className="status-banner error">{myRideRefreshError}</div>}
            {locationError && <div className="status-banner error">{locationError}</div>}

            {phase === 'building' && (
              <div className="ride-request-form-row" style={{ marginTop: '0.5rem' }}>
                <div className="ride-request-fare-col">
                  <label className="label">Fare ($)</label>
                  <input
                    ref={fareInputRef}
                    type="text"
                    inputMode="decimal"
                    value={fare}
                    onChange={(e) => setFare(e.target.value)}
                    className="input-field"
                    placeholder="Enter fare after selecting route"
                    disabled={!pickup || !dropoff}
                  />
                </div>
                <div className="ride-request-actions">
                  <button
                    type="button"
                    className="btn-primary ride-request-btn"
                    disabled={!(pickup && dropoff && fare) || isLoading}
                    onClick={() => handleSubmit()}
                  >
                    {isLoading ? 'Submitting…' : 'Confirm request'}
                  </button>
                </div>
              </div>
            )}
            {requestReferrer && (
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: '0.5rem 0 0 0' }}>
                Referrer on this request: {requestReferrer}
              </p>
            )}

            {phase === 'waiting' && (
              <div style={{ marginTop: '0.5rem' }}>
                {previousRequests.map((req, idx) => (
                  <RideRequestCard
                    key={req.txHash || idx}
                    req={req}
                    userProfile={userProfile}
                    hubSdk={hubSdk}
                    onAcceptSuccess={() => setRefreshBalanceCounter((prev) => prev + 1)}
                    onCancelSuccess={() => setRefreshBalanceCounter((prev) => prev + 1)}
                    requestPrivateKey={requestPrivateKey}
                  />
                ))}
              </div>
            )}

            {phase === 'trip' && (
              <div style={{ marginTop: '0.5rem' }}>
                {myTripsRefreshError && <div className="status-banner error">{myTripsRefreshError}</div>}
                {activeTrips.map((trip) => (
                  <ActiveTripCard
                    key={trip.txHash}
                    trip={trip}
                    passengerPayment={{ userProfile, onSuccess: () => setRefreshBalanceCounter((prev) => prev + 1) }}
                    cancelAction={{ userProfile, onSuccess: () => setRefreshBalanceCounter((prev) => prev + 1) }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </BottomSheet>

      <OverlayPanel
        open={passengerTab === 'recent'}
        title="Recent rides"
        onClose={() => {
          setPassengerTab('rides');
          onTabSync?.('rides');
        }}
      >
        {!userProfile.publicKey ? (
          <EmptyState message="Connect your wallet to view recent rides." />
        ) : (
          <>
            {recentTripsError && <div className="status-banner error">{recentTripsError}</div>}
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 1rem 0' }}>
              Includes completed trips and cancelled rides. Active trips stay on the map.
            </p>
            {recentTrips.length > 0 ? (
              recentTrips.map((trip) => <CompletedTripCard key={trip.txHash} trip={trip} />)
            ) : !recentTripsLoading && !recentTripsError ? (
              <EmptyState message="No recent rides yet. When you finish paying or cancel a trip, it will appear here." />
            ) : null}
          </>
        )}
      </OverlayPanel>

      <PrivateKeyModal />
    </div>
  );
};

export default PassengerView;
