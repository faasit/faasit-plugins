# client.py
import grpc
import comm_pb2
import comm_pb2_grpc
import os
def run_checkpoint(master_address, file_path, payload_path, function_name):
    with grpc.insecure_channel(master_address) as channel:
        stub = comm_pb2_grpc.NodeCommunicationStub(channel)
        
        with open(file_path, 'rb') as f:
            file_content = f.read()
        
        payload_content = None
        if payload_path is not None:
            with open(payload_path, 'rb') as f:
                payload_content = f.read()
        
        request = comm_pb2.CliCheckpointRequest(
            file_content=file_content,
            payload=payload_content,
            function=function_name,
        )
        if function_name is not None:
            print(f"Execute function name: {function_name}")
        if payload_path:
            print(f"Client sent payload decode: {str(payload_content, encoding='utf-8')}")
        
        response = stub.ExecuteCheckpoint(request)
        
        print("Checkpoint Response:")
        print(f"Success: {response.success}")
        print(f"Output: {response.output}")
        if not response.success:
            print(f"Error: {response.error}")

def run_restore(master_address, restore_mode, restore_num):
    with grpc.insecure_channel(master_address) as channel:
        stub = comm_pb2_grpc.NodeCommunicationStub(channel)
        
        request = comm_pb2.CliRestoreRequest(
            restore_mode=restore_mode,
            restore_num=restore_num
        )
        
        response = stub.ExecuteRestore(request)
        
        print("Restore Response:")
        print(f"Success: {response.success}")
        print(f"Output: {response.output}")
        if not response.success:
            print(f"Error: {response.error}")

def run_prepare(master_address, file_path):
    with grpc.insecure_channel(master_address) as channel:
        stub = comm_pb2_grpc.NodeCommunicationStub(channel)
        with open(file_path, 'rb') as f:
            file_content = f.read()
        request = comm_pb2.CliPrepareEnvRequest(
            file_content=file_content
        )
        response = stub.ExecutePrepare(request)

        print(f"env prepare result: success: {response.success}, output: {response.output}")
        
def run_upload(master_address, file_path, relative_file_path):
     with grpc.insecure_channel(master_address) as channel:
        stub = comm_pb2_grpc.NodeCommunicationStub(channel)
        with open(file_path, 'rb') as f:
            file_content = f.read()
        request = comm_pb2.CliUploadFileRequest(
            file_content=file_content,
            file_path=relative_file_path,
        )
        response = stub.ExecuteUploadFile(request)

        print(f"env prepare result: success: {response.success}, output: {response.output}")

def run_init(master_address):
    with grpc.insecure_channel(master_address) as channel:
        stub = comm_pb2_grpc.NodeCommunicationStub(channel)
        with open("./cli.py", 'rb') as f:
            cli_content_patch = f.read()
        request = comm_pb2.CliStartContainerRequest(cli_content_patch=cli_content_patch)
        response = stub.ExecuteStartContainer(request)
        print(f"Container init result: Success: {response.success}, Output: {response.output}")
        if not response.success:
            print(f"Error: {response.error}")
    


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Distributed System Client')
    parser.add_argument('--master', type=str, default='localhost:50050', help='Master server address')
    subparsers = parser.add_subparsers(dest='command', required=True)

    checkpoint_parser = subparsers.add_parser('checkpoint')
    checkpoint_parser.add_argument('--file', type=str, help='File to upload')
    checkpoint_parser.add_argument('--payload', type=str, default=None, help='Payload file to send')
    checkpoint_parser.add_argument('--function', type=str, default=None, help='Function Name')

    restore_parser = subparsers.add_parser('restore')
    restore_parser.add_argument('--restore_mode', type=str, required=True, help='Restore mode')
    restore_parser.add_argument('--restore_num', type=int, required=True, help='Restore number')

    prepare_parser = subparsers.add_parser('prepare')
    prepare_parser.add_argument('--file', type=str)

    prepare_parser = subparsers.add_parser('upload')
    prepare_parser.add_argument('--file', type=str)
    prepare_parser.add_argument('--rel_path', type=str) # relative path to checkpoint file
    

    subparsers.add_parser('init')

    args = parser.parse_args()

    channel = grpc.insecure_channel(f"{args.master}")
    try:
        grpc.channel_ready_future(channel).result(timeout=10)
    except grpc.FutureTimeoutError:
        print("Error: Failed to connect to server")
    else:
        print("Successfully connected to server")

    if args.command == 'checkpoint':
        run_checkpoint(args.master, args.file, args.payload, args.function)
    elif args.command == 'restore':
        run_restore(args.master, args.restore_mode, args.restore_num)
    elif args.command == 'prepare':
        run_prepare(args.master, args.file)
    elif args.command == 'upload':
        run_upload(args.master, args.file,args.rel_path)
    elif args.command == 'init':
        run_init(args.master)