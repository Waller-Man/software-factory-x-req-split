"""Bind once; communicate the owned listener to DSH, then serve HTTP."""
import json
import logging
import os
import socket
import uvicorn


def main():
    if not os.environ.get('X_REQ_SPLIT_TOKEN') or not os.environ.get('X_REQ_SPLIT_INSTANCE'):
        raise RuntimeError('请在现有 DSH 中启用 x-req-split，不能独立启动')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', int(os.environ.get('XAGENTS_PORT', '0'))))
    listener.listen(128)
    print(json.dumps({'type': 'listening', 'port': listener.getsockname()[1],
                      'instance': os.environ['X_REQ_SPLIT_INSTANCE']}), flush=True)
    try:
        uvicorn.Server(uvicorn.Config('src.server:app', log_level='info',
            timeout_graceful_shutdown=10)).run(sockets=[listener])
    finally:
        listener.close()


if __name__ == '__main__':
    main()
